FROM amazon/aws-lambda-nodejs:22

COPY ./package.json ./package-lock.json ./

ENV NODE_ENV=production

RUN npm install --only=prod;
RUN dnf install -y nss \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXrandr \
    libXext \
    libXi \
    libXScrnSaver \
    libXtst \
    pango \
    alsa-lib \
    gtk3 && \
    dnf clean all && \
    rm -rf /var/cache/dnf

COPY . ${LAMBDA_TASK_ROOT}

EXPOSE 9000

CMD [ "index.lambdaHandler" ]
