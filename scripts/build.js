import { ZipArchive } from "archiver";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";

// 解析命令行参数
const args = process.argv.slice(2);
const isWatch = args.includes("--watch") || args.includes("-w");
const isMinify = args.includes("--minify") || args.includes("-m");

// 解析自定义输出目录参数 --out-dir=<dir> 或 -o <dir>
let outDir = path.resolve("dist");
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--out-dir=")) {
    outDir = path.resolve(args[i].split("=")[1]);
  } else if (args[i] === "-o" && args[i + 1]) {
    outDir = path.resolve(args[i + 1]);
  }
}

// 目标文件/目录过滤（排除以 - 开头的参数）
const positionalArgs = args.filter(
  (arg) => !arg.startsWith("-") && !["dist"].includes(arg),
);
const specificTarget = positionalArgs[0]
  ? path.resolve(positionalArgs[0])
  : null;

const THEMES_ROOT = path.resolve("themes");

/**
 * 向上查找所在主题包的元数据（meta.json）
 * @param {string} startDir - 起始目录（通常是 manifest 所在目录）
 */
function findThemeMeta(startDir) {
  let current = startDir;
  while (
    current &&
    current !== path.dirname(THEMES_ROOT) &&
    current !== THEMES_ROOT
  ) {
    const metaPath = path.join(current, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        return {
          dir: current,
          name: content.name || path.basename(current),
          version: content.version || "1.0.0",
          metaPath,
        };
      } catch (e) {
        console.warn(`[WARN] 解析 ${metaPath} 失败: ${e.message}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 回退：取 themes 根目录下的第一级子目录名
  const rel = path.relative(THEMES_ROOT, startDir);
  const topSubdir = rel.split(path.sep)[0] || path.basename(startDir);
  return {
    dir: path.join(THEMES_ROOT, topSubdir),
    name: topSubdir,
    version: "1.0.0",
    metaPath: null,
  };
}

/**
 * 递归查找所有 theme.manifest.json 文件
 */
function findManifestFiles(dir) {
  const manifests = [];
  if (!fs.existsSync(dir)) return manifests;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...findManifestFiles(fullPath));
    } else if (entry.name === "theme.manifest.json") {
      manifests.push(fullPath);
    }
  }
  return manifests;
}

/**
 * 打包指定 JSON 文件为 ZIP 包
 * @param {string} zipPath - 输出 zip 路径
 * @param {string[]} jsonFiles - 包含的 json 文件路径列表
 */
function createThemeZip(zipPath, jsonFiles) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => resolve(archive.pointer()));
    archive.on("error", (err) => reject(err));

    archive.pipe(output);

    for (const file of jsonFiles) {
      archive.file(file, { name: path.basename(file) });
    }

    archive.finalize();
  });
}

/**
 * 编译单个主题变体
 * @param {string} manifestPath - theme.manifest.json 路径
 * @param {object} themeMeta - 主题包元数据 { dir, name, version }
 * @param {string} themeOutDir - 该主题专属输出目录
 * @returns {{ success: boolean, jsonPath?: string }} 编译结果
 */
function buildVariant(manifestPath, themeMeta, themeOutDir) {
  const variantDir = path.dirname(manifestPath);
  const relativeDir = path.relative(process.cwd(), variantDir);

  try {
    // 1. 读取并解析 manifest.json
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw);

    // 2. 寻找对应的 SCSS / CSS 文件
    const scssPath = path.join(variantDir, "theme.scss");
    const cssPath = path.join(variantDir, "theme.css");

    let compiledCss = "";

    if (fs.existsSync(scssPath)) {
      const compileResult = sass.compile(scssPath, {
        style: isMinify ? "compressed" : "expanded",
        loadPaths: [
          variantDir,
          path.dirname(variantDir),
          themeMeta.dir,
          path.join(themeMeta.dir, "src"),
          THEMES_ROOT,
        ],
      });
      compiledCss = compileResult.css.trim();
    } else if (fs.existsSync(cssPath)) {
      compiledCss = fs.readFileSync(cssPath, "utf-8").trim();
    } else {
      console.warn(
        `[WARN] [${relativeDir}] 未找到 theme.scss 或 theme.css，使用现有 custom_css`,
      );
      compiledCss = manifest.custom_css || "";
    }

    // 3. 将编译结果注入到 custom_css 字段
    manifest.custom_css = compiledCss;

    // 4. 决定输出基础名与内部 name（带版本号）
    const baseName = manifest.name ? manifest.name : path.basename(variantDir);

    // 内部 name 字段拼接版本号（若未拼接）
    const versionSuffix = `_${themeMeta.version}`;
    if (themeMeta.version && !manifest.name?.endsWith(versionSuffix)) {
      manifest.name = `${baseName}${versionSuffix}`;
    }

    // 5. 决定输出文件名（文件名保持干净，不拼接版本号以方便打包与分发）
    const jsonFileName = `${baseName}.json`;
    const cssFileName = `${baseName}.css`;
    const jsonOutputPath = path.join(themeOutDir, jsonFileName);
    const cssOutputPath = path.join(themeOutDir, cssFileName);

    // 6. 写入最终的 JSON 主题文件与 CSS 文件
    fs.writeFileSync(
      jsonOutputPath,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      cssOutputPath,
      compiledCss ? compiledCss + "\n" : "",
      "utf-8",
    );

    const jsonStats = fs.statSync(jsonOutputPath);
    const jsonSizeKb = (jsonStats.size / 1024).toFixed(2);
    const relativeJsonOut = path.relative(process.cwd(), jsonOutputPath);

    const cssStats = fs.statSync(cssOutputPath);
    const cssSizeKb = (cssStats.size / 1024).toFixed(2);
    const relativeCssOut = path.relative(process.cwd(), cssOutputPath);

    console.log(
      `[OK] ${relativeDir} -> ${relativeJsonOut} (${jsonSizeKb} KB), ${relativeCssOut} (${cssSizeKb} KB)`,
    );
    return { success: true, jsonPath: jsonOutputPath };
  } catch (error) {
    console.error(`[FAIL] ${relativeDir}:`);
    if (error.sassMessage) {
      console.error(`  ${error.sassMessage}`);
      if (error.span) {
        console.error(
          `  Line ${error.span.start.line + 1}, Column ${error.span.start.column + 1}`,
        );
      }
    } else {
      console.error(`  ${error.message}`);
    }
    return { success: false };
  }
}

/**
 * 执行一次全量或指定目标的构建
 */
async function runBuild() {
  console.log(
    `\n开始构建主题 (输出目录: ${path.relative(process.cwd(), outDir) || "."}) ...`,
  );
  const startTime = Date.now();

  let manifestFiles = [];

  if (specificTarget) {
    if (fs.existsSync(specificTarget)) {
      const stat = fs.statSync(specificTarget);
      if (
        stat.isFile() &&
        path.basename(specificTarget) === "theme.manifest.json"
      ) {
        manifestFiles = [specificTarget];
      } else if (stat.isDirectory()) {
        manifestFiles = findManifestFiles(specificTarget);
      }
    }
  } else {
    manifestFiles = findManifestFiles(THEMES_ROOT);
  }

  if (manifestFiles.length === 0) {
    console.warn(`[WARN] 未找到任何 theme.manifest.json 文件`);
    return true;
  }

  // 按主题包进行归类
  const themePackages = new Map();
  for (const manifestFile of manifestFiles) {
    const meta = findThemeMeta(path.dirname(manifestFile));
    if (!themePackages.has(meta.dir)) {
      themePackages.set(meta.dir, { meta, manifests: [] });
    }
    themePackages.get(meta.dir).manifests.push(manifestFile);
  }

  let successCount = 0;
  let failCount = 0;

  for (const [themeDir, pkg] of themePackages.entries()) {
    const themeOutDir = path.join(outDir, pkg.meta.name);
    fs.mkdirSync(themeOutDir, { recursive: true });

    const generatedJsonFiles = [];
    let pkgSuccess = true;

    for (const manifestFile of pkg.manifests) {
      const result = buildVariant(manifestFile, pkg.meta, themeOutDir);
      if (result.success) {
        successCount++;
        if (result.jsonPath) generatedJsonFiles.push(result.jsonPath);
      } else {
        failCount++;
        pkgSuccess = false;
      }
    }

    // 主题下的所有变体编译完成后，打包该主题的 Release zip
    if (pkgSuccess && generatedJsonFiles.length > 0) {
      const zipFileName = `${pkg.meta.name}_${pkg.meta.version}.zip`;
      const zipOutputPath = path.join(themeOutDir, zipFileName);
      try {
        const totalBytes = await createThemeZip(
          zipOutputPath,
          generatedJsonFiles,
        );
        const zipSizeKb = (totalBytes / 1024).toFixed(2);
        const relativeZipOut = path.relative(process.cwd(), zipOutputPath);
        console.log(
          `[ZIP] 打包发布文件: ${relativeZipOut} (${zipSizeKb} KB, 包含 ${generatedJsonFiles.length} 个主题 JSON)`,
        );
      } catch (zipErr) {
        console.error(`[FAIL] 打包 ${zipFileName} 失败: ${zipErr.message}`);
        failCount++;
      }
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(
    `完成! 成功: ${successCount}，失败: ${failCount} (耗时: ${duration}s)\n`,
  );

  return failCount === 0;
}

// 主入口
if (isWatch) {
  await runBuild();
  console.log(`正在监听 themes/ 目录变更... (Ctrl+C 退出)`);

  let debounceTimer = null;
  fs.watch(THEMES_ROOT, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.includes(".git") || filename.includes("node_modules")) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      console.log(`\n检测到文件变更: ${filename}，正在重新构建...`);
      await runBuild();
    }, 150);
  });
} else {
  const success = await runBuild();
  if (!success) {
    process.exit(1);
  }
}
