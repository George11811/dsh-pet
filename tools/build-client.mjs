/**
 * 从 res/ 里的桌宠压缩包生成 assets/（运行时素材）和 lib/client.js。
 *
 *   node tools/build-client.mjs                    # 默认：res/ → assets/
 *   node tools/build-client.mjs --force            # 压缩包没变也重新解压
 *   node tools/build-client.mjs --strict           # POOLS 里有对不上的名字就失败退出
 *   node tools/build-client.mjs --res <目录> --assets <目录>
 *
 * 分工：
 *   res/            素材库：用户把桌宠压缩包（.7z / .zip / .rar / .tar*）丢这里
 *   assets/<宠物>/   运行时目录：每个压缩包解出一个同名目录，Host 半边按文件名递归提供，
 *                   客户端在运行时切换宠物（纯前端，不用重新生成、不用重启）
 *
 * 流程：
 *   1. 解压：res/ 下每个压缩包解到 assets/<包名>/（已有解压结果且比压缩包新就跳过）；
 *      包内自套的一层目录会被拍平，保证是稳定的 assets/<宠物>/*.gif；
 *   2. 扫描：把 assets/ 下每个顶层目录当作一只宠物，递归找它的 GIF；
 *      每个 GIF 用帧延时算出一轮时长，文件名去掉「宠物公共前缀 + 导出时间戳」当显示名；
 *   3. 分池：按显示名把动画分进状态机的池子；名字对不上的宠物，会把没人认领的动画
 *      轮流填进空池子（保证每个状态都有动作，不至于全场只有待机）；
 *   4. 生成：把 src/client.template.js 的标记替换成真实数据，写出 lib/client.js。
 */
import { spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 支持的压缩包后缀。 */
const ARCHIVE_EXTENSIONS = ['.7z', '.zip', '.rar', '.tar', '.gz', '.tgz']

/** 解压器候选：优先 7-Zip（读 7z/zip/rar 都行），再退到 libarchive 的 tar。 */
const EXTRACTORS = [
  { command: '7z', args: (archive, target) => ['x', '-y', '-bso0', '-bsp0', `-o${target}`, archive] },
  { command: '7za', args: (archive, target) => ['x', '-y', '-bso0', '-bsp0', `-o${target}`, archive] },
  { command: '7zr', args: (archive, target) => ['x', '-y', '-bso0', '-bsp0', `-o${target}`, archive] },
  { command: '7zz', args: (archive, target) => ['x', '-y', '-bso0', '-bsp0', `-o${target}`, archive] },
  { command: 'C:\\Program Files\\7-Zip\\7z.exe', args: (archive, target) => ['x', '-y', '-bso0', '-bsp0', `-o${target}`, archive] },
  { command: 'C:\\Program Files (x86)\\7-Zip\\7z.exe', args: (archive, target) => ['x', '-y', '-bso0', '-bsp0', `-o${target}`, archive] },
  { command: 'tar', args: (archive, target) => ['-xf', archive, '-C', target] },
  { command: 'bsdtar', args: (archive, target) => ['-xf', archive, '-C', target] },
]

/**
 * 状态机的池子。用**显示名**（去掉宠物公共前缀和导出时间戳之后的名字）写。
 * 一个动画可以同时属于多个池子；没被任何池子收留的自动进 roam。
 * 换新桌宠时把这里改成新素材的名字即可；名字对不上不会报错（会退化成自动铺满），
 * 加 --strict 才当失败处理。
 */
const POOLS = {
  // DSH 正在干活：刚开工像在思考，之后像在打字/折腾
  think: ['思考(认真地)', '思考(自信地)', '正在思考', '主意', '记录 1'],
  work: [
    '打字(普通)',
    '打字(恼怒)',
    '打字(生气)',
    '工作(普通)',
    '工作(生气)',
    '工作(疲倦)',
    '撬棍 1',
    '撬棍 2',
    '撬棍 3',
    '魔法',
    '敲头',
    '刷卡',
    '画板',
    '电风扇 1',
    '电风扇 2',
    '喷剂',
    '胶带',
    '拍蝇',
    '烧 1',
    '烧 2',
    '刀 1',
    '刀 2',
    '枪',
    '坐牢 1',
    '坐牢 2',
    '停止工作',
  ],
  // 有会话在等你回答（审批/提问）
  attention: ['期待 1', '期待 2', '问号', '打招呼 1', '打招呼 2', '摇铃', '扩音器', '点头', '指', '紧张 1', '紧张 2'],
  // 刚干完活的那一下
  celebrate: ['庆祝', '点赞', '干杯', '加油', '玫瑰', '爱心 1', '爱心 2', '爱心 3', '得分(10分)', '复活节', '唱歌', '跳舞 1', '摇铃'],
  // 后台会话干完了、你还没看
  notify: ['通知_提示 爱心_喜欢', '通知_提示 点赞', '通知_提示 星星_收藏', '通知_提示 硬币', '通知_提示 Bits', '通知_自定义', '摇铃', '扩音器', '红包 1', '红包 2', '礼物 1', '礼物 2'],
  // 被点一下 → 卖萌
  moe: ['害羞 1', '害羞 2', '爱心 1', '爱心 2', '爱心 3', '点赞', '反向点赞', '舔舔', '眨眼', '摸头', '点头', '玫瑰', '期待 1', '加油'],
  // 被拎着（拖拽全程只播其中一个，不切换）
  hold: ['害怕 1', '害怕 2', '惊吓', '紧张 1', '紧张 2', '汗', '头晕', '问号'],
  // 刚被放下（整段只播其中一个）
  drop: ['被击中(拖鞋)', '被击中(爱心)', '被击中(硬币)', '被击中(Bits)', '惊吓', '头晕', '生气', '反转', '死亡', '自我安慰'],
  // 没事干时的「生活」
  sleep: ['睡觉(准备阶段1)', '睡觉(准备阶段2)', '睡觉(普通)', '睡觉 (UU)', '工作(小睡)'],
  eat: ['吃(甜甜圈)', '吃(西瓜)', '吃(爆米花)', '馋(刀叉)', '馋(筷子)', '喝(饮料杯)', '蛋糕', '干杯'],
  sing: ['唱歌', '吉他', '跳舞 1', '跳舞(Caramelldansen)', '跳舞(Helltaker)', '跳舞(低皮质醇)', '荧光棒 2', '舞蹈(散味)', '摇铃'],
  slack: ['带薪拉屎(简单模式)', '带薪拉屎(困难模式)', '打游戏', '静音 1', '静音 2', '驾驶', '记录 2', '画板', '电风扇 1', '电风扇 2', '摇可乐', '自我安慰'],
  daze: ['呆 1', '呆 2', '呆 3', '呆(贴纸) 1', '呆(贴纸) 2', '呆(贴纸) 3', '六七', '六七(呆)', '冒泡 1', '冒泡 2', '眨眼', '舔舔', 'Popcat 平滑', 'Popcat 帧', '一切都好 1', '一切都好 2', '一切都好 3', '摇头', '点头'],
  mischief: ['小丑 1', '小丑 2', '拍蝇', '拖鞋 1', '拖鞋 2', '胶带', '垃圾桶', '按钮', '摇可乐', '墨镜循环', '墨镜反光', '摘掉墨镜', '像素墨镜反光', '折扇', '要米', '拿走我的钱', '钱', '主意', '反转', '到达', '到达(拿筷子)', '到达(拿勺子)', '抓拍(手机)', '抓拍(摄像机)', '情书', '催眠'],
}

function tryExtract(archive, target) {
  const failures = []
  for (const extractor of EXTRACTORS) {
    // 注意：这里不能传 windowsHide —— 在这个沙箱里它会让孩子进程（7z.exe）以
    // 0xC0000142（DLL 初始化失败）退出，而同样的命令不加这个选项就能跑。
    const result = spawnSync(extractor.command, extractor.args(archive, target), { stdio: 'ignore' })
    if (result.error === undefined && result.status === 0) return { extractor: extractor.command, failures }
    const reason = result.error !== undefined ? result.error.message : `exit ${result.status}`
    failures.push(`${extractor.command}: ${reason}`)
  }
  return { extractor: undefined, failures }
}

/**
 * 压缩包内常常自套一层目录（常见的是 `assets/`）。
 * 拍平「唯一一条目录链」，让每只宠物都是稳定的 assets/<宠物>/*.gif。
 */
async function flattenSingleChain(target) {
  for (let depth = 0; depth < 6; depth += 1) {
    let entries
    try {
      entries = await fsp.readdir(target, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.isFile() && /\.gif$/i.test(entry.name))) return
    if (entries.length !== 1 || !entries[0].isDirectory()) return
    const inner = path.join(target, entries[0].name)
    for (const name of await fsp.readdir(inner)) {
      try {
        await fsp.rename(path.join(inner, name), path.join(target, name))
      } catch {
        /* 同名冲突就留着，让它在下一层被递归扫到 */
      }
    }
    await fsp.rm(inner, { recursive: true, force: true })
  }
}

/** 读一个 GIF，返回一轮播放的毫秒数（帧延时之和，无延时按 100ms/帧）。 */
function gifLoopMs(buffer) {
  if (buffer.length < 14 || buffer.toString('latin1', 0, 3) !== 'GIF') return undefined
  const flags = buffer[10]
  let offset = 13
  if ((flags & 0x80) !== 0) offset += 3 * 2 ** ((flags & 0x07) + 1)

  let delayHundredths = 0
  let frames = 0
  let sawDelay = false

  while (offset < buffer.length) {
    const marker = buffer[offset]
    if (marker === 0x3b) break // trailer
    if (marker === 0x21) {
      const label = buffer[offset + 1]
      if (label === 0xf9 && offset + 6 < buffer.length) {
        const delay = buffer.readUInt16LE(offset + 4)
        if (delay > 0) {
          delayHundredths += delay
          sawDelay = true
        }
      }
      let cursor = offset + 2
      while (cursor < buffer.length && buffer[cursor] !== 0) cursor += buffer[cursor] + 1
      offset = cursor + 1
      continue
    }
    if (marker === 0x2c) {
      const imageFlags = buffer[offset + 9]
      let cursor = offset + 10
      if ((imageFlags & 0x80) !== 0) cursor += 3 * 2 ** ((imageFlags & 0x07) + 1)
      cursor += 1 // LZW minimum code size
      while (cursor < buffer.length && buffer[cursor] !== 0) cursor += buffer[cursor] + 1
      offset = cursor + 1
      frames += 1
      continue
    }
    break // 结构不认识，就此打住
  }

  if (frames === 0) return undefined
  if (!sawDelay) return frames * 100
  return Math.max(delayHundredths, frames) * 10
}

/** 去掉导出工具追加的时间戳和首尾空白。 */
function stripTimestamp(name) {
  return name
    .replace(/[_-]\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/, '')
    .replace(/[_-]\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/, '')
    .trim()
}

/** 一组名字的公共前缀。 */
function commonPrefix(names) {
  if (names.length === 0) return ''
  let prefix = names[0]
  for (const name of names) {
    while (prefix !== '' && !name.startsWith(prefix)) prefix = prefix.slice(0, -1)
    if (prefix === '') return ''
  }
  return prefix
}

/**
 * 每只宠物一套显示名：先去掉所有文件名的公共前缀（宠物名通常在这里），
 * 前缀收到最后一个分隔符为止（免得把名字切一半），再剥时间戳。
 */
function displayNamesFor(basenames) {
  const prefix = commonPrefix(basenames)
  const boundary = Math.max(prefix.lastIndexOf('_'), prefix.lastIndexOf('-'), prefix.lastIndexOf(' '))
  const cut = boundary >= 0 ? prefix.slice(0, boundary + 1) : ''
  return basenames.map((base) => stripTimestamp(base.slice(cut.length).replace(/\.gif$/i, '')) || stripTimestamp(base.replace(/\.gif$/i, '')))
}

/** 递归列出目录下（跳过 . 开头的目录）的所有 GIF，返回 POSIX 相对路径。 */
async function listGifs(root) {
  const found = []
  async function walk(dir, prefix) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative)
      else if (/\.gif$/i.test(entry.name)) found.push(relative)
    }
  }
  await walk(root, '')
  return found.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** 把一只宠物的池子解析成文件名数组；空池用没人认领的动画轮流铺满。 */
function resolvePoolsFor(petAssets, byName) {
  const resolved = {}
  const unmatched = new Set()
  const claimed = new Set()
  let matchedKeys = 0
  const poolKeys = Object.keys(POOLS)
  for (const key of poolKeys) {
    const files = []
    for (const name of POOLS[key]) {
      const asset = byName.get(name)
      if (!asset) {
        unmatched.add(name)
        continue
      }
      files.push(asset.f)
      claimed.add(asset.f)
    }
    if (files.length > 0) matchedKeys += 1
    resolved[key] = files
  }

  const leftovers = petAssets.filter((asset) => !claimed.has(asset.f))
  const emptyKeys = Object.keys(resolved).filter((key) => resolved[key].length === 0)
  if (emptyKeys.length > 0 && leftovers.length > 0) {
    leftovers.forEach((asset, index) => {
      const key = emptyKeys[index % emptyKeys.length]
      resolved[key].push(asset.f)
      claimed.add(asset.f)
    })
  }
  const filledKeys = emptyKeys.filter((key) => resolved[key].length > 0).length

  resolved.roam = petAssets.filter((asset) => !claimed.has(asset.f)).map((asset) => asset.f)
  if (resolved.roam.length === 0) {
    // roam 空了不影响运行（客户端会退回该宠物的全部素材），补几个让它有内容。
    resolved.roam = petAssets.slice(0, Math.min(8, petAssets.length)).map((asset) => asset.f)
  }
  return { resolved, unmatched: [...unmatched], matchedKeys, filledKeys, totalKeys: poolKeys.length }
}

// ── 1. 解压 res/ 里的压缩包到 assets/ ──────────────────────────────────────
const archiveReport = []
let archives = []
try {
  const entries = await fsp.readdir(resRoot, { withFileTypes: true })
  archives = entries
    .filter((entry) => entry.isFile() && ARCHIVE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
} catch {
  archives = []
}

for (const archiveName of archives) {
  const archivePath = path.join(resRoot, archiveName)
  const target = path.join(assetsRoot, path.basename(archiveName, path.extname(archiveName)))
  const already = await listGifs(target)
  const archiveStat = await fsp.stat(archivePath)
  let targetTime = 0
  try {
    targetTime = (await fsp.stat(target)).mtimeMs
  } catch {
    targetTime = 0
  }

  if (!force && already.length > 0 && targetTime >= archiveStat.mtimeMs) {
    archiveReport.push(`跳过解压 ${archiveName}（${path.basename(target)}/ 已是最新，${already.length} 个 GIF）`)
  } else {
    if (already.length > 0) await fsp.rm(target, { recursive: true, force: true })
    await fsp.mkdir(target, { recursive: true })
    const result = tryExtract(archivePath, target)
    if (result.extractor === undefined) {
      console.error(`解压 ${archiveName} 失败，试过的解压器都不行：`)
      for (const failure of result.failures) console.error(`  - ${failure}`)
      console.error('  装个 7-Zip（7z.exe）最省事。')
      process.exit(1)
    }
    archiveReport.push(`解压 ${archiveName} → assets/${path.basename(target)}/（${result.extractor}）`)
  }
  await flattenSingleChain(target)
  archiveReport.push(`  assets/${path.basename(target)}/ 现有 ${(await listGifs(target)).length} 个 GIF`)
}

// ── 2. 扫描 assets/ 下的每只宠物 ──────────────────────────────────────────
const pets = []
try {
  const entries = await fsp.readdir(assetsRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('__')) continue
    const dir = path.join(assetsRoot, entry.name)
    const gifs = await listGifs(dir)
    if (gifs.length > 0) pets.push({ id: entry.name, label: entry.name, dir, prefix: `${entry.name}/`, gifs })
  }
  // 素材直接躺在 assets/ 根目录的情况：当成一只叫 default 的宠物
  const rootGifs = (await listGifs(assetsRoot)).filter((relative) => !relative.includes('/'))
  if (rootGifs.length > 0) {
    pets.push({ id: 'default', label: 'default', dir: assetsRoot, prefix: '', gifs: rootGifs })
  }
} catch {
  /* assets/ 不存在就是没有素材 */
}

if (pets.length === 0) {
  console.error(`没有在 ${assetsRoot} 找到任何宠物素材。`)
  console.error(`把桌宠压缩包（.7z / .zip）放进 ${resRoot} 再跑一次。`)
  process.exit(1)
}

// ── 3. 每只宠物：读时长、算显示名、分池 ───────────────────────────────────
const assets = []
const poolsByPet = {}
const petSummaries = []
const warnings = []

for (const pet of pets) {
  const basenames = pet.gifs.map((relative) => relative.split('/').pop())
  const names = displayNamesFor(basenames)
  const byName = new Map()
  const petAssets = []

  for (let index = 0; index < pet.gifs.length; index += 1) {
    const relative = pet.gifs[index]
    const buffer = await fsp.readFile(path.join(pet.dir, ...relative.split('/')))
    const loopMs = gifLoopMs(buffer)
    const asset = {
      // f：相对 assets/ 的路径，唯一标识（池子、固定动作都用它）
      f: `${pet.prefix}${relative}`,
      // u：URL 片段 = 带宠物目录的相对路径（逐段编码）。
      //    必须带目录：只按文件名的话，两只宠物有同名文件时后一只会取到前一只的图。
      //    Host 半边两条路都认（相对路径直接命中 / 按文件名兜底），所以这仍然稳。
      u: `${pet.prefix}${relative}`
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/'),
      n: names[index],
      ms: Math.max(600, Math.min(loopMs ?? 2400, 12000)),
      pet: pet.id,
    }
    assets.push(asset)
    petAssets.push(asset)
    if (!byName.has(asset.n)) byName.set(asset.n, asset)
  }

  const { resolved, unmatched, matchedKeys, filledKeys, totalKeys } = resolvePoolsFor(petAssets, byName)
  poolsByPet[pet.id] = resolved
  petSummaries.push({ id: pet.id, label: pet.label, count: petAssets.length })

  if (unmatched.length > 0) {
    const own = petAssets.slice(0, 5).map((asset) => asset.n).join('、')
    warnings.push(
      `宠物 ${pet.id}：按名字只匹配到 ${matchedKeys}/${totalKeys} 个池子（${unmatched.length} 个名字没对上）；` +
        `${filledKeys} 个空池已用素材自动铺满，其余空池运行时会退回该宠物的全部素材。` +
        `要让状态机贴题，就把 POOLS 里的名字改成这只宠物的（例如：${own}）`,
    )
  }
}

// ── 4. 生成 ───────────────────────────────────────────────────────────────
const template = await fsp.readFile(templatePath, 'utf8')
const markers = [
  ['/* @__PETS__@ */ []', JSON.stringify(petSummaries)],
  ['/* @__ANIMATIONS__@ */ []', JSON.stringify(assets)],
  ['/* @__POOLS__@ */ {}', JSON.stringify(poolsByPet)],
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
for (const line of archiveReport) console.log(`  ${line}`)
console.log(`宠物: ${petSummaries.map((pet) => `${pet.id}(${pet.count})`).join('、')}`)
console.log(`动画: ${assets.length} 个，一轮时长 ${Math.min(...loops)}–${Math.max(...loops)} ms`)
for (const pet of petSummaries) {
  console.log(
    `  ${pet.id} 池子: ` +
      Object.entries(poolsByPet[pet.id])
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
