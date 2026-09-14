# SillyTavern 主题开发

```bash
# 安装依赖
pnpm install

# 构建所有主题（输出到 dist/ 目录）
pnpm run build

# 监听模式（修改 SCSS 或 manifest 时自动增量重新编译）
pnpm run watch

# 仅构建指定主题
node scripts/build.js themes/Neumorphism-Psi/dark

# 压缩输出 CSS
node scripts/build.js --minify

# 指定输出目录
node scripts/build.js --out-dir=./custom_dist
```
