/**
 * 从 res/ 里的桌宠压缩包生成 assets/（运行时素材）和 lib/client.js（离线兜底数据）。
 *
 *   node tools/build-client.mjs                    # 默认：res/ → assets/ + 重新生成 lib/client.js
 *   node tools/build-client.mjs --force            # 压缩包没变也重新解压
 *   node tools/build-client.mjs --strict           # 有池子名字没对上就失败退出
 *   node tools/build-client.mjs --res <目录> --assets <目录>
 *
 * 现在这个脚本不再是必需品：Host 半边在运行时也会扫同一份花名册
 * （GET <prefix>/__roster），面板里点「重扫 / 导入」就能加新宠物。
 * 它仍然有用的地方：
 *   1. 离线兜底 —— 把数据写进 lib/client.js，Host 半边不可用时宠物照样能用；
 *   2. 命令行路径 —— 一次把 res/ 里所有压缩包解压好（含首次 5 秒的时长扫描）。
 *
 * 扫描/命名/分池的逻辑全在 lib/catalog.mjs，和 Host 半边共用一份。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCatalog,
  importArchives,
  loadLoopCache,
  saveLoopCache,
} from '../lib/catalog.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const force = argv.includes('--force')
const strict = argv.includes('--strict')
function flagValue(name) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? argv[index + 1] : undefined
}
const resRoot = path.resolve(flagValue('--res') ?? path.join(packageRoot, 'res'))
const assetsRoot = path.resolve(flagValue('--assets') ?? path.join(packageRoot, 'assets'))
const templatePath = path.join(packageRoot, 'src', 'client.template.js')
const outputPath = path.join(packageRoot, 'lib', 'client.js')
const routePrefix = '/fish-pet'
// 和 Host 半边共用同一个时长缓存：构建时算过一遍，运行时扫描就直接命中。
const loopCacheFile = path.join(assetsRoot, '.fish-pet-loops.json')

// ── 1. 解压 res/ 里的压缩包到 assets/ ──────────────────────────────────────
const { report: archiveReport, failures, extracted } = await importArchives({
  resRoot,
  assetsRoot,
  force,
})

for (const line of archiveReport) console.log(`  ${line}`)
if (failures.length > 0) {
  console.error(`有 ${failures.length} 个压缩包没解压成功：`)
  for (const failure of failures) console.error(`  - ${failure.archive}: ${failure.reason}`)
  console.error('  装个 7-Zip（7z.exe）最省事。')
  // 已有的素材还能用，但解压失败要退出非零，免得 CI/脚本以为一切正常。
  if (extracted.length === 0) process.exit(1)
}

// ── 2. 扫描 assets/ 下的每只宠物（和 Host 半边同一份逻辑） ────────────────
const loopCache = await loadLoopCache(loopCacheFile)
const scanStarted = Date.now()
const { pets, assets, pools, warnings, loopKeys } = await buildCatalog({ assetsRoot, loopCache })
await saveLoopCache(loopCacheFile, loopCache, loopKeys)
const scanMs = Date.now() - scanStarted

if (pets.length === 0) {
  console.error(`没有在 ${assetsRoot} 找到任何宠物素材。`)
  console.error(`把桌宠压缩包（.7z / .zip）放进 ${resRoot} 再跑一次，或者在 dsh 面板里点「导入」/「重扫」。`)
  process.exit(1)
}

// ── 3. 生成 lib/client.js ─────────────────────────────────────────────────
const template = await fsp.readFile(templatePath, 'utf8')
const markers = [
  ['/* @__PETS__@ */ []', JSON.stringify(pets)],
  ['/* @__ANIMATIONS__@ */ []', JSON.stringify(assets)],
  ['/* @__POOLS__@ */ {}', JSON.stringify(pools)],
  ["/* @__BASE__@ */ '/fish-pet'", JSON.stringify(routePrefix)],
]
for (const [marker] of markers) {
  if (!template.includes(marker)) {
    console.error(`模板里找不到标记：${marker}`)
    process.exit(1)
  }
}
let output = template
for (const [marker, replacement] of markers) output = output.replace(marker, replacement)

await fsp.mkdir(path.dirname(outputPath), { recursive: true })
await fsp.writeFile(outputPath, output, 'utf8')

const loops = assets.map((asset) => asset.ms)
console.log(`素材库: ${resRoot}`)
console.log(`运行时: ${assetsRoot}`)
console.log(`宠物: ${pets.map((pet) => `${pet.id}(${pet.count})`).join('、')}`)
console.log(`动画: ${assets.length} 个，一轮时长 ${Math.min(...loops)}–${Math.max(...loops)} ms（扫描 ${scanMs} ms）`)
for (const pet of pets) {
  console.log(
    `  ${pet.id} 池子: ` +
      Object.entries(pools[pet.id])
        .map(([key, files]) => `${key}=${files.length}`)
        .join(' '),
  )
}
for (const warning of warnings) console.log(`  警告 ${warning}`)
console.log(`已写出: ${outputPath}`)

if (strict && warnings.length > 0) {
  console.error('--strict：有池子名字没匹配上，按失败处理。')
  process.exit(1)
}
