const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");

const { rimrafSync } = require("rimraf");

const { execCmdSync } = require("../../../scripts/util");

function isCertChainError(error) {
  const code = error?.cause?.code || error?.code;
  return (
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  );
}

function escapePowerShellSingleQuoted(value) {
  return value.replace(/'/g, "''");
}

function downloadFileWithPowerShell(url, outputPath) {
  const escapedUrl = escapePowerShellSingleQuoted(url);
  const escapedOutputPath = escapePowerShellSingleQuoted(outputPath);
  execCmdSync(
    `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedOutputPath}' -MaximumRedirection 10"`,
  );
}

/**
 * download a file using fetch API
 * @param {string} url
 * @param {string} outputPath
 */
async function downloadFile(url, outputPath) {
  // Create output directory if it doesn't exist.
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Use proxy if set in environment variables
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  let agent;
  if (proxy) {
    try {
      const { ProxyAgent } = require("undici");
      agent = new ProxyAgent(proxy);
    } catch (error) {
      console.warn(
        `[warn] Proxy is configured but undici is unavailable; proceeding without proxy dispatcher. ${error.message}`,
      );
    }
  }

  let response;
  try {
    response = await fetch(url, {
      redirect: "follow", // Automatically follow redirects
      dispatcher: agent,
    });
  } catch (error) {
    if (process.platform === "win32" && isCertChainError(error)) {
      console.warn(
        `[warn] Fetch failed due to TLS certificate validation (${error.cause?.code || error.code}); retrying with PowerShell download`,
      );
      downloadFileWithPowerShell(url, outputPath);
      return;
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Failed to download file, status code: ${response.status}`);
  }

  // Get the response as an array buffer and write it to the file
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

/**
 *
 * @param {string} target platform specific target
 * @param {string} targetDir the directory to download into
 */
async function downloadSqlite(target, targetDir) {
  const downloadUrl =
    // node-sqlite3 doesn't have a pre-built binary for win32-arm64
    target === "win32-arm64"
      ? "https://continue-server-binaries.s3.us-west-1.amazonaws.com/win32-arm64/node_sqlite3.tar.gz"
      : `https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-${
          target
        }.tar.gz`;
  await downloadFile(downloadUrl, targetDir);
}

async function installAndCopySqlite(target) {
  // Replace the installed with pre-built
  console.log("[info] Downloading pre-built sqlite3 binary");
  rimrafSync("../../core/node_modules/sqlite3/build");
  await downloadSqlite(target, "../../core/node_modules/sqlite3/build.tar.gz");
  execCmdSync("cd ../../core/node_modules/sqlite3 && tar -xvzf build.tar.gz");
  fs.unlinkSync("../../core/node_modules/sqlite3/build.tar.gz");
}

async function installAndCopyEsbuild(target) {
  // Download and unzip esbuild
  console.log("[info] Downloading pre-built esbuild binary");
  rimrafSync("node_modules/@esbuild");
  fs.mkdirSync("node_modules/@esbuild", { recursive: true });
  await downloadFile(
    `https://continue-server-binaries.s3.us-west-1.amazonaws.com/${target}/esbuild.zip`,
    "node_modules/@esbuild/esbuild.zip",
  );
  execCmdSync("cd node_modules/@esbuild && unzip esbuild.zip");
  fs.unlinkSync("node_modules/@esbuild/esbuild.zip");
}

process.on("message", (msg) => {
  const { operation, target } = msg.payload;
  if (operation === "sqlite") {
    installAndCopySqlite(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
  if (operation === "esbuild") {
    installAndCopyEsbuild(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
});

/**
 * @param {string} target the platform to build for
 */
async function copySqlite(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "sqlite",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `sqlite child process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
          ),
        );
      }
    });

    child.on("message", (msg) => {
      if (msg.error) {
        reject(new Error("sqlite download/copy failed"));
      } else {
        resolve();
      }
    });
  });
}

/**
 * @param {string} target the platform to build for
 */
async function copyEsbuild(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "esbuild",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `esbuild child process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
          ),
        );
      }
    });

    child.on("message", (msg) => {
      if (msg.error) {
        reject(new Error("esbuild download/copy failed"));
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  downloadSqlite,
  copySqlite,
  copyEsbuild,
};
