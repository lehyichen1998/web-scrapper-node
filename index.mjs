import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import chromium from "@sparticuz/chromium";
import dotenv from "dotenv";
import fs from "fs/promises";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

// Polyfill for __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const s3 = new S3Client({ region: "ap-southeast-2" });

function getDateRange() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Calculate Sunday of the *previous* week
  const endDate = new Date(today);
  endDate.setDate(today.getDate() - dayOfWeek); // Go back to the previous Sunday (or today if today is Sunday)
  endDate.setHours(23, 59, 59, 999); // Set to end of the day

  // Calculate Monday of the *previous* week
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - 6); // Go back 6 days from Sunday to get Monday
  startDate.setHours(0, 0, 0, 0); // Set to start of the day

  // Format dates as YYYY-MM-DD for the input field
  const formatForInput = (d) => {
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  return {
    startDate: formatForInput(startDate),
    endDate: formatForInput(endDate),
  };
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

export async function runScraper(headless) {
  let browser;
  let downloadDir;

  const { ATLAS_USERNAME, ATLAS_PASSWORD } = process.env;
  if (!ATLAS_USERNAME || !ATLAS_PASSWORD) {
    throw new Error("ATLAS_USERNAME and ATLAS_PASSWORD must be set");
  }

  try {
    const args = {
      ...(headless && {
        args: [
          ...chromium.args.filter((a) => a !== "--single-process"),
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
        ],
      }),
      ...(headless && { executablePath: await chromium.executablePath() }),
      headless,
    };

    browser = await puppeteer.launch(args);

    const page = await browser.newPage();

    await page.goto("https://atlas.praxispay.com/site/login", {
      waitUntil: "networkidle2",
    });

    await page.type('input[name="LoginForm[username]"]', ATLAS_USERNAME);
    await page.type('input[name="LoginForm[password]"]', ATLAS_PASSWORD);
    await page.click('button[name="login-button"]');
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    console.log("Logged in successfully, navigating to transactions page...");
    await page.goto("https://atlas.praxispay.com/transaction/index", {
      waitUntil: "networkidle2",
    });
    await wait(3000);

    const templateModalSelector = "#show-template-modal";
    await page.waitForSelector(templateModalSelector, { timeout: 10000 });

    await page.click(templateModalSelector);

    await wait(3000);

    console.log("Waiting for 'Export' filter link...");
    const exportFilterSelector = "li[data-id='1097']";
    try {
      await page.waitForSelector(exportFilterSelector, {
        visible: true,
        timeout: 10000,
      });

      console.log("Selecting 'Export' filter...");
      await page.click(exportFilterSelector);
    } catch (error) {
      console.error("Could not find or click 'Export' filter link:", error);
      throw new Error("Failed to select 'Export' filter template.");
    }

    await wait(1000);
    console.log("Applying the pre-made filter...");
    const applyLinkSelector = "#template-apply";
    try {
      await page.waitForSelector(applyLinkSelector, {
        visible: true,
        timeout: 10000,
      });
      await page.click(applyLinkSelector);
    } catch (error) {
      console.error("Could not find or click 'APPLY' link:", error);
      throw new Error("Failed to click 'APPLY' link after selecting filter.");
    }

    await wait(3000);

    const { startDate, endDate } = getDateRange();
    const dateRange = `${startDate} 12:00 AM - ${endDate} 11:59 PM`;

    await page.evaluate((range) => {
      const input = document.getElementById("transaction_created");
      if (input) {
        input.value = range;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, dateRange);

    console.log(`Setting date range: ${dateRange}`);

    await wait(1000);

    await page.evaluate(() => {
      const applyBtn = [...document.querySelectorAll("button")].find(
        (el) => el.textContent.trim() === "APPLY"
      );
      applyBtn?.click();
    });

    console.log("Date range applied, waiting for export...");
    await page.waitForNavigation({ waitUntil: "networkidle2" });
    await wait(3000);

    // Create a unique temporary directory using mkdtemp (adds random chars automatically)
    const downloadPrefix = path.join(os.tmpdir(), "atlas-downloads-");
    downloadDir = await fs.mkdtemp(downloadPrefix);
    console.log(`Created unique download directory: ${downloadDir}`);

    // Configure Puppeteer to allow downloads into the unique directory
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir, // Use the unique directory path
    });

    console.log("Clicking export button...");
    await page.evaluate(async () => {
      const downloadBtn = [...document.querySelectorAll("a")].find(
        (el) => el.textContent.trim() === "Export as CSV"
      );
      if (downloadBtn) {
        downloadBtn.click();
      } else {
        throw new Error("Export as CSV button not found");
      }
    });

    console.log("CSV export initiated, waiting for download to complete...");

    // Function to wait for the download to appear in the directory
    const waitForDownload = (dir) =>
      new Promise(async (resolve, reject) => {
        const timeoutMillis = 30000;
        const pollIntervalMillis = 1000;
        const startTime = Date.now();

        const interval = setInterval(async () => {
          if (Date.now() - startTime > timeoutMillis) {
            clearInterval(interval);
            // Clean up the unique directory on timeout
            await fs
              .rm(dir, { recursive: true, force: true })
              .catch((err) =>
                console.error(`Error cleaning up ${dir} on timeout:`, err)
              );
            return reject(
              new Error(
                `Download timeout after ${timeoutMillis / 1000} seconds`
              )
            );
          }

          try {
            const currentFiles = await fs.readdir(dir);
            for (const file of currentFiles) {
              // Look for *any* CSV file within the unique directory
              if (file.endsWith(".csv")) {
                const filePath = path.join(dir, file);
                // Check if file size is stable
                const stats = await fs.stat(filePath);
                if (stats.size > 0) {
                  // Optional: Add a small delay to ensure writing is finished
                  await new Promise((res) => setTimeout(res, 500));
                  const finalStats = await fs.stat(filePath);
                  if (finalStats.size === stats.size) {
                    // Check if size stabilized
                    clearInterval(interval);
                    // Don't clean up here, let the main logic handle it after upload
                    return resolve(filePath);
                  }
                }
              }
            }
          } catch (err) {
            // If the directory disappears, it's an issue
            if (err.code === "ENOENT") {
              clearInterval(interval);
              return reject(
                new Error(`Download directory ${dir} disappeared unexpectedly.`)
              );
            }
            // Log other errors during polling
            console.warn("Polling warning:", err.message);
          }
        }, pollIntervalMillis);
      });

    const filePath = await waitForDownload(downloadDir);
    console.log("Download complete. File saved at:", filePath);

    const fileBuffer = await fs.readFile(filePath);
    const s3Key = `atlas_exports/${startDate}_to_${endDate}_transactions.csv`;

    console.log(`Uploading to s3://bbm-snowflake-stage/${s3Key}`);
    const uploadCmd = new PutObjectCommand({
      Bucket: "bbm-snowflake-stage",
      Key: s3Key,
      Body: fileBuffer,
    });

    await s3.send(uploadCmd);
    console.log("Upload complete");

    // Clean up the unique temporary directory and its contents
    console.log(`Cleaning up temporary directory: ${downloadDir}`);
    await fs.rm(downloadDir, { recursive: true, force: true });
    console.log("Temporary directory cleaned up.");
  } catch (err) {
    console.error("Error during scraping:", err);
    // Attempt cleanup even on error
    if (downloadDir) {
      console.log(`Attempting cleanup of ${downloadDir} after error...`);
      await fs
        .rm(downloadDir, { recursive: true, force: true })
        .catch((cleanupErr) =>
          console.error(`Error during cleanup after error:`, cleanupErr)
        );
    }
    throw err;
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed");
    }
  }
}

export const lambdaHandler = async (event = {}, context = {}) => {
  await runScraper(true);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  dotenv.config({ path: path.join(__dirname, ".env") });

  runScraper(Boolean(process.argv[2])).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
