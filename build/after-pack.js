// electron-builder afterPack hook: node-pty's macOS/Linux `spawn-helper` ships
// from npm without its executable bit, which makes every pty.spawn fail with
// "posix_spawnp failed". Restore +x in the packed (unpacked) app so the shipped
// build works out of the box, independent of the runtime self-heal in main.js.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'darwin' && platform !== 'linux') return;

  const productFilename = context.packager.appInfo.productFilename;
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');

  const prebuilds = path.join(
    resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');

  for (const dir of [`${platform}-arm64`, `${platform}-x64`]) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log('  • chmod +x ' + path.relative(context.appOutDir, helper));
    }
  }
};
