ARG BUILDER_IMAGE
FROM ${BUILDER_IMAGE}

COPY builder-cache.sh builder-packages.txt builder-repositories.sha256 /recipe/
COPY inputs /builder-inputs
RUN sh /recipe/builder-cache.sh install /builder-inputs/apt

ARG NODE_SHA256
RUN printf '%s  /builder-inputs/node.tar.xz\n' "$NODE_SHA256" | sha256sum --check --strict \
    && mkdir /opt/node \
    && tar -xJf /builder-inputs/node.tar.xz --strip-components=1 -C /opt/node

ENV PATH="/opt/node/bin:${PATH}"
WORKDIR /work/source
