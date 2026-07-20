// 插件构建脚本：先用 esbuild 打包 TypeScript，再按 EasyEDA .eext 格式生成 ZIP 包。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import JSZip from "jszip";

// 所有路径都相对于本脚本所在目录，避免依赖调用命令时的 cwd。
const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension.json"), "utf8"));
const dist = path.join(root, "dist");
// dist 是纯生成目录，构建前清空可避免旧 iframe 或旧 bundle 混入安装包。
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// EasyEDA 扩展加载浏览器端 IIFE，导出名由平台约定读取。
await esbuild.build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(dist, "index.js"),
  bundle: true,
  format: "iife",
  globalName: "edaEsbuildExportName",
  platform: "browser",
  target: "es2022",
  minify: false,
});

// --compile 只生成 dist/index.js，默认模式还会打包商店要求的元数据、图标和运行资源。
if (!process.argv.includes("--compile")) {
  const zip = new JSZip();
  zip.file("extension.json", JSON.stringify(manifest, null, "\t"));
  zip.file("dist/index.js", fs.readFileSync(path.join(dist, "index.js")));
  for (const name of ["README.md", "CHANGELOG.md", "LICENSE"]) {
    zip.file(name, fs.readFileSync(path.join(root, name)));
  }
  zip.file("images/logo.png", fs.readFileSync(path.join(root, "images", "logo.png")));
  // 状态悬浮窗页面按原文件名放入安装包的 iframe 目录。
  for (const name of fs.readdirSync(path.join(root, "iframe"))) {
    zip.file(`iframe/${name}`, fs.readFileSync(path.join(root, "iframe", name)));
  }
  const output = path.join(dist, `${manifest.name}_v${manifest.version}.eext`);
  fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } }));
  process.stdout.write(`${output}\n`);
}
