# bee-threads Benchmark Dockerfile
# Runs benchmarks on both Node.js and Bun

FROM node:22-slim
WORKDIR /app

# Install Bun
RUN apt-get update && apt-get install -y curl unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.bun/bin:$PATH"

# Copy package files from parent directory
COPY package.json package-lock.json* ./
RUN npm install

# Copy source files
COPY src ./src
COPY tsconfig.json ./

# Copy benchmark files
COPY benchmarks ./benchmarks

# Build TypeScript
RUN npm run build

# Make benchmark script executable (convert CRLF to LF)
COPY benchmarks/run-benchmarks.sh ./run-benchmarks.sh
RUN sed -i 's/\r$//' run-benchmarks.sh && chmod +x run-benchmarks.sh

CMD ["./run-benchmarks.sh"]
