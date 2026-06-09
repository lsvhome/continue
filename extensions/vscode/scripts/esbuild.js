const fs = require("fs");
const path = require("path");

const { writeBuildTimestamp } = require("./utils");

const esbuild = require("esbuild");

const flags = process.argv.slice(2);

const esbuildConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode", "esbuild", "./xhr-sync-worker.js"],
  format: "cjs",
  platform: "node",
  sourcemap: flags.includes("--sourcemap"),
  loader: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ".node": "file",
  },

  // To allow import.meta.path for transformers.js
  // https://github.com/evanw/esbuild/issues/1492#issuecomment-893144483
  inject: ["./scripts/importMetaUrl.js"],
  define: { "import.meta.url": "importMetaUrl" },
  supported: { "dynamic-import": false },
  metafile: true,
  plugins: [
    {
      name: "openai-resource-path-compat",
      setup(build) {
        // Some installs of openai@5.x contain flattened resource files such as
        // resources/chat/completions.js but omit nested JS entrypoints such as
        // resources/chat/completions/completions.js. Remap known nested imports
        // to their flattened equivalents when the nested file is missing.
        build.onResolve({ filter: /^\.\// }, (args) => {
          const isOpenAiResourceImporter = args.importer.includes(
            `${path.sep}node_modules${path.sep}openai${path.sep}resources${path.sep}`,
          );
          if (!isOpenAiResourceImporter || !args.path.endsWith(".js")) {
            return;
          }

          const importerDir = path.dirname(args.importer);
          const nestedFilePath = path.resolve(importerDir, args.path);
          if (fs.existsSync(nestedFilePath)) {
            return;
          }

          const repeatedNameImport = args.path.match(/^\.\/([^/]+)\/\1\.js$/);
          const indexImport = args.path.match(/^\.\/([^/]+)\/index\.js$/);
          const fallbackBaseName =
            repeatedNameImport?.[1] || indexImport?.[1] || null;

          if (!fallbackBaseName) {
            return;
          }

          const flattenedFilePath = path.resolve(
            importerDir,
            `./${fallbackBaseName}.js`,
          );

          if (fs.existsSync(flattenedFilePath)) {
            return { path: flattenedFilePath };
          }
        });
      },
    },
    {
      name: "on-end-plugin",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error("Build failed with errors:", result.errors);
            throw new Error(result.errors);
          } else {
            try {
              fs.writeFileSync(
                "./build/meta.json",
                JSON.stringify(result.metafile, null, 2),
              );
            } catch (e) {
              console.error("Failed to write esbuild meta file", e);
            }
            console.log("VS Code Extension esbuild complete"); // used verbatim in vscode tasks to detect completion
          }
        });
      },
    },
  ],
};

void (async () => {
  // Create .buildTimestamp.js before starting the first build
  writeBuildTimestamp();
  // Bundles the extension into one file
  if (flags.includes("--watch")) {
    const ctx = await esbuild.context(esbuildConfig);
    await ctx.watch();
  } else if (flags.includes("--notify")) {
    const inFile = esbuildConfig.entryPoints[0];
    const outFile = esbuildConfig.outfile;

    // The watcher automatically notices changes to source files
    // so the only thing it needs to be notified about is if the
    // output file gets removed.
    if (fs.existsSync(outFile)) {
      console.log("VS Code Extension esbuild up to date");
      return;
    }

    fs.watchFile(outFile, (current, previous) => {
      if (current.size > 0) {
        console.log("VS Code Extension esbuild rebuild complete");
        fs.unwatchFile(outFile);
        process.exit(0);
      }
    });

    console.log("Triggering VS Code Extension esbuild rebuild...");
    writeBuildTimestamp();
  } else {
    await esbuild.build(esbuildConfig);
  }
})();
