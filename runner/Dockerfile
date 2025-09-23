FROM ubuntu:22.04

# Install basic deps
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl git sudo unzip apt-transport-https ca-certificates \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 \
    libx11-xcb1 libxcomposite1 libxrandr2 libxdamage1 \
    libgbm1 libasound2 xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (adjust version as needed)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Install Chrome
RUN curl -sSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm /tmp/chrome.deb

# Install vulkan and mesa utils
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      mesa-vulkan-drivers \
      mesa-utils \
      vulkan-tools \
      libvulkan1 && \
    rm -rf /var/lib/apt/lists/*

# Create runner user
RUN useradd -m runner
WORKDIR /home/runner

# Download runner
RUN curl -fsSL https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-linux-x64-2.328.0.tar.gz \
    | tar xz

# Install runner deps
RUN ./bin/installdependencies.sh

# Create render group safely and add runner
RUN groupadd -g 104 -f render \
    && usermod -aG render runner

USER runner

# Copy entrypoint
COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh

ENTRYPOINT ["/home/runner/entrypoint.sh"]
