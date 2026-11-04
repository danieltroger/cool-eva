ARG BUILDER_IMAGE
FROM ${BUILDER_IMAGE}

ARG APT_SNAPSHOT
RUN printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' "$APT_SNAPSHOT" > /etc/apt/sources.list.d/debian.sources
RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates curl xz-utils zstd python3 make g++ libc6-dev binutils

ARG NODE_VERSION
ARG NODE_SHA256
RUN curl --fail --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" -o /tmp/node.tar.xz \
    && printf '%s  /tmp/node.tar.xz\n' "$NODE_SHA256" | sha256sum --check --strict \
    && mkdir /opt/node \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node

ENV PATH="/opt/node/bin:${PATH}"
WORKDIR /work/source
