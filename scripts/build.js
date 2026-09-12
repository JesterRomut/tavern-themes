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
 * 编译单个主题
 * @param {string} manifestPath - theme.manifest.json 路径
 * @returns {boolean} 是否成功
 */
function buildTheme(manifestPath) {
  const themeDir = path.dirname(manifestPath);
  const relativeDir = path.relative(process.cwd(), themeDir);

  try {
    // 1. 读取并解析 manifest.json
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw);

    // 2. 寻找对应的 SCSS / CSS 文件
    const scssPath = path.join(themeDir, "theme.scss");
    const cssPath = path.join(themeDir, "theme.css");

    let compiledCss = "";

    if (fs.existsSync(scssPath)) {
      const compileResult = sass.compile(scssPath, {
        style: isMinify ? "compressed" : "expanded",
        loadPaths: [themeDir, path.dirname(themeDir), THEMES_ROOT],
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

    // 4. 确保输出目录存在
    fs.mkdirSync(outDir, { recursive: true });

    // 5. 决定输出文件名（优先使用 manifest.name，回退到目录名）
    const baseName = manifest.name ? manifest.name : path.basename(themeDir);
    const jsonFileName = baseName + ".json";
    const cssFileName = baseName + ".css";
    const jsonOutputPath = path.join(outDir, jsonFileName);
    const cssOutputPath = path.join(outDir, cssFileName);

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
    return true;
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
    return false;
  }
}

/**
 * 执行一次全量或指定目标的构建
 */
function runBuild() {
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

  let successCount = 0;
  let failCount = 0;

  for (const manifestFile of manifestFiles) {
    const ok = buildTheme(manifestFile);
    if (ok) successCount++;
    else failCount++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(
    `完成! 成功: ${successCount}，失败: ${failCount} (耗时: ${duration}s)\n`,
  );

  return failCount === 0;
}

// 主入口
if (isWatch) {
  runBuild();
  console.log(`正在监听 themes/ 目录变更... (Ctrl+C 退出)`);

  let debounceTimer = null;
  fs.watch(THEMES_ROOT, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.includes(".git") || filename.includes("node_modules")) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(`\n检测到文件变更: ${filename}，正在重新构建...`);
      runBuild();
    }, 150);
  });
} else {
  const success = runBuild();
  if (!success) {
    process.exit(1);
  }
}
