/**
 * 素材花名册（catalog）：res/ + assets/ → 宠物 / 动画 / 池子。
 *
 * 这一份被两边共用：
 *   - Host 半边 lib/index.js：运行时扫描出花名册，用 /__roster 接口发给浏览器，
 *     这样「往 assets/ 丢一只新宠物 → 面板里点重扫就能切」不需要重新构建；
 *   - 构建脚本 tools/build-client.mjs：同一份数据写进 lib/client.js 当离线兜底。
 *
 * 共用的意义是「运行时看到的数据」和「构建时写死的数据」永远一致 —— 同一种
 * 命名规则、同一张池子表、同一套分池策略，不会出现两边对不上的鬼故事。
 *
 * 目录约定：
 *   res/             素材库：用户把桌宠压缩包（.7z/.zip/.rar/.tar*）丢这里
 *   assets/<宠物>/   运行时目录：每个压缩包解出一个同名目录，里面有 GIF
 */
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 支持的压缩包后缀（Host 与构建脚本共用）。 */
export const ARCHIVE_EXTENSIONS = ['.7z', '.zip', '.rar', '.tar', '.gz', '.tgz']

/**
 * 状态机的池子。用**显示名**（去掉宠物公共前缀和导出时间戳之后的名字）写。
 * 一个动画可以同时属于多个池子；没被任何池子收留的自动进 roam。
 * 换新桌宠时把这里改成新素材的名字即可；名字对不上不会报错（会退化成自动铺满）。
 */
export const POOLS = {
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

/** 解压器候选：优先 7-Zip（读 7z/zip/rar 都行），再退到 libarchive 的 tar。 */
export const EXTRACTORS = [
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
 * 解压一个压缩包到 target（异步：Host 半边在处理 HTTP 请求，不能用同步版本把整个
 * dsh 进程卡住几秒）。依次尝试各个解压器，全失败就把每个失败原因带回去。
 *
 * 注意：这里刻意不传 windowsHide —— 在这个沙箱里它会让孩子进程（7z.exe）以
 * 0xC0000142（DLL 初始化失败）退出，而同样的命令不加这个选项就能跑。
 */
export function tryExtract(archive, target) {
  return new Promise((resolve) => {
    const failures = []
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const attempt = (index) => {
      if (index >= EXTRACTORS.length) {
        done({ extractor: undefined, failures })
        return
      }
      const extractor = EXTRACTORS[index]
      let child
      try {
        child = spawn(extractor.command, extractor.args(archive, target), { stdio: 'ignore' })
      } catch (error) {
        failures.push(`${extractor.command}: ${error instanceof Error ? error.message : String(error)}`)
        attempt(index + 1)
        return
      }
      child.on('error', (error) => {
        failures.push(`${extractor.command}: ${error.message}`)
        attempt(index + 1)
      })
      child.on('exit', (code) => {
        if (code === 0) done({ extractor: extractor.command, failures })
        else {
          failures.push(`${extractor.command}: exit ${code}`)
          attempt(index + 1)
        }
      })
    }
    attempt(0)
  })
}

/**
 * 压缩包内常常自套一层目录（常见的是 `assets/`）。
 * 拍平「唯一一条目录链」，让每只宠物都是稳定的 assets/<宠物>/*.gif。
 */
export async function flattenSingleChain(target) {
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
export function gifLoopMs(buffer) {
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
export function stripTimestamp(name) {
  return name
    .replace(/[_-]\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/, '')
    .replace(/[_-]\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/, '')
    .trim()
}

/** 一组名字的公共前缀。 */
export function commonPrefix(names) {
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
export function displayNamesFor(basenames) {
  const prefix = commonPrefix(basenames)
  const boundary = Math.max(prefix.lastIndexOf('_'), prefix.lastIndexOf('-'), prefix.lastIndexOf(' '))
  const cut = boundary >= 0 ? prefix.slice(0, boundary + 1) : ''
  return basenames.map(
    (base) => stripTimestamp(base.slice(cut.length).replace(/\.gif$/i, '')) || stripTimestamp(base.replace(/\.gif$/i, '')),
  )
}

/** 递归列出目录下（跳过 . 开头的目录）的所有 GIF，返回 POSIX 相对路径。 */
export async function listGifs(root) {
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
export function resolvePoolsFor(petAssets, byName) {
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

/**
 * 扫描 assets/ 下的每只宠物。
 * @returns {Promise<Array<{id: string, label: string, dir: string, prefix: string, gifs: string[]}>>}
 */
export async function scanPets(assetsRoot) {
  const pets = []
  try {
    const entries = await fsp.readdir(assetsRoot, { withFileTypes: true })
    for (const entry of entries) {
      // `.`/`__` 开头的是内部目录（缓存、临时文件），不当宠物
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('__')) continue
      const dir = path.join(assetsRoot, entry.name)
      const gifs = await listGifs(dir)
      if (gifs.length > 0) pets.push({ id: entry.name, label: entry.name, dir, prefix: `${entry.name}/`, gifs })
    }
    // 素材直接躺在 assets/ 根目录的情况：当成一只叫 default 的宠物
    const rootGifs = (await listGifs(assetsRoot)).filter((relative) => !relative.includes('/'))
    if (rootGifs.length > 0) pets.push({ id: 'default', label: 'default', dir: assetsRoot, prefix: '', gifs: rootGifs })
  } catch {
    /* assets/ 不存在就是没有素材 */
  }
  return pets
}

/**
 * 扫出完整花名册：宠物列表 + 每个动画（含显示名、一轮时长）+ 每只宠物的池子。
 * @param {{assetsRoot: string, loopCache?: Map<string, number>}} options
 *   loopCache：可选，「相对路径|size|mtime → 毫秒」的缓存。GIF 的一轮时长要把整个
 *   文件读一遍才算得出来，几百 MB 的素材每次重扫都读一遍太浪费，所以允许外部传缓存。
 */
export async function buildCatalog({ assetsRoot, loopCache }) {
  const pets = await scanPets(assetsRoot)
  const assets = []
  const pools = {}
  const summaries = []
  const warnings = []
  /** 这次扫描还认得的缓存键（在用的素材），用来把过期条目从缓存里剔掉。 */
  const loopKeys = new Set()

  for (const pet of pets) {
    const basenames = pet.gifs.map((relative) => relative.split('/').pop())
    const names = displayNamesFor(basenames)
    const byName = new Map()
    const petAssets = []

    for (let index = 0; index < pet.gifs.length; index += 1) {
      const relative = pet.gifs[index]
      const full = path.join(pet.dir, ...relative.split('/'))
      const f = `${pet.prefix}${relative}`
      let loopMs
      try {
        const info = await fsp.stat(full)
        const key = `${f}|${info.size}|${Math.floor(info.mtimeMs)}`
        loopKeys.add(key)
        const cached = loopCache && loopCache.get(key)
        if (typeof cached === 'number') loopMs = cached
        else {
          loopMs = gifLoopMs(await fsp.readFile(full))
          if (loopCache && typeof loopMs === 'number') loopCache.set(key, loopMs)
        }
      } catch {
        loopMs = undefined
      }
      const asset = {
        // f：相对 assets/ 的路径，唯一标识（池子、固定动作都用它）
        f,
        // u：URL 片段 = 带宠物目录的相对路径（逐段编码）。
        //    必须带目录：只按文件名的话，两只宠物有同名文件时后一只会取到前一只的图。
        //    Host 半边两条路都认（相对路径直接命中 / 按文件名兜底），所以这仍然稳。
        u: f.split('/').map((segment) => encodeURIComponent(segment)).join('/'),
        n: names[index],
        ms: Math.max(600, Math.min(loopMs ?? 2400, 12000)),
        pet: pet.id,
      }
      assets.push(asset)
      petAssets.push(asset)
      if (!byName.has(asset.n)) byName.set(asset.n, asset)
    }

    const { resolved, unmatched, matchedKeys, filledKeys, totalKeys } = resolvePoolsFor(petAssets, byName)
    pools[pet.id] = resolved
    summaries.push({ id: pet.id, label: pet.label, count: petAssets.length })

    // 只在「有池子一个名字都没对上」时提醒：别的宠物的名字没对上属于正常现象
    // （池子表是给主素材写的），全对上就不用吓人。
    if (matchedKeys < totalKeys) {
      const own = petAssets
        .slice(0, 5)
        .map((asset) => asset.n)
        .join('、')
      warnings.push(
        `宠物 ${pet.id}：只匹配到 ${matchedKeys}/${totalKeys} 个池子（${unmatched.length} 个池子名字在这只宠物里找不到）；` +
          `${filledKeys} 个空池已用素材自动铺满，其余空池运行时会退回该宠物的全部素材。` +
          `要让状态机贴题，就把 lib/catalog.mjs 里 POOLS 的名字改成这只宠物的（例如：${own}）`,
      )
    }
  }

  return { pets: summaries, assets, pools, warnings, loopKeys: [...loopKeys] }
}

/**
 * 一轮时长的持久化缓存：GIF 的一轮时长要把整个文件读一遍才算得出来，
 * 157 个 GIF / 460 MB 扫一次要 5 秒左右。缓存键是「相对路径|大小|mtime」，
 * 所以素材改了会自动重算，没改的直接命中。
 */
export async function loadLoopCache(file) {
  const cache = new Map()
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    const entries = parsed && typeof parsed === 'object' ? parsed.entries : null
    if (entries && typeof entries === 'object') {
      for (const [key, value] of Object.entries(entries)) if (typeof value === 'number') cache.set(key, value)
    }
  } catch {
    /* 没有缓存文件 / 内容坏了都当成空缓存 */
  }
  return cache
}

/** 写回缓存；只保留这次扫描还在用的键（旧素材删掉后缓存不会无限长大）。 */
export async function saveLoopCache(file, cache, usedKeys) {
  const entries = {}
  for (const key of usedKeys) {
    const value = cache.get(key)
    if (typeof value === 'number') entries[key] = value
  }
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify({ version: 1, entries }), 'utf8')
  } catch {
    /* 写不进去只是下次慢一点，不影响功能 */
  }
}

/** 压缩包文件名 → 宠物目录名；不合法的名字返回空串（不要悄悄当宠物收下）。 */
export function petIdForArchive(name) {
  const base = path.basename(String(name), path.extname(String(name))).trim()
  if (base === '' || base === '.' || base === '..') return ''
  if (base.startsWith('.') || base.startsWith('__')) return ''
  if (base.includes('/') || base.includes('\\')) return ''
  return base
}

/** 列出 res/ 里的压缩包（按名字排序）。 */
export async function listArchives(resRoot) {
  let entries
  try {
    entries = await fsp.readdir(resRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && ARCHIVE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: entry.name, path: path.join(resRoot, entry.name), pet: petIdForArchive(entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * res/ 里每个压缩包的状态：是否已经解压过（目标目录有 GIF 且不比压缩包旧）。
 * 面板拿这个显示「还有几个包没导入」。
 */
export async function archiveStatus({ resRoot, assetsRoot }) {
  const archives = await listArchives(resRoot)
  const list = []
  for (const archive of archives) {
    if (archive.pet === '') {
      list.push({ name: archive.name, pet: '', gifs: 0, extracted: false, reason: 'badName' })
      continue
    }
    const target = path.join(assetsRoot, archive.pet)
    const gifs = await listGifs(target)
    let targetTime = 0
    let archiveTime = 0
    try {
      targetTime = (await fsp.stat(target)).mtimeMs
    } catch {
      targetTime = 0
    }
    try {
      archiveTime = (await fsp.stat(archive.path)).mtimeMs
    } catch {
      archiveTime = 0
    }
    list.push({
      name: archive.name,
      pet: archive.pet,
      path: archive.path,
      target,
      gifs: gifs.length,
      extracted: gifs.length > 0 && targetTime >= archiveTime,
    })
  }
  return list
}

/**
 * 把 res/ 里的压缩包解压到 assets/ —— 面板上那个「导入」按钮走的就是这里。
 * 没有任何请求参数能影响目标路径：目标永远由压缩包自身的文件名决定，
 * 所以这个接口不可能被拿来往任意位置写文件。
 * @param {{resRoot: string, assetsRoot: string, force?: boolean}} options
 */
export async function importArchives({ resRoot, assetsRoot, force = false }) {
  const status = await archiveStatus({ resRoot, assetsRoot })
  const report = []
  const extracted = []
  const failures = []

  for (const item of status) {
    if (item.pet === '') {
      const reason = '压缩包名字不能当宠物目录名（去掉扩展名后为空、或以 . / __ 开头）'
      failures.push({ archive: item.name, reason })
      report.push(`跳过 ${item.name}：${reason}`)
      continue
    }
    if (!force && item.extracted) {
      report.push(`跳过 ${item.name}（assets/${item.pet}/ 已是最新，${item.gifs} 个 GIF）`)
      continue
    }
    if (item.gifs > 0) await fsp.rm(item.target, { recursive: true, force: true })
    await fsp.mkdir(item.target, { recursive: true })
    const result = await tryExtract(item.path ?? path.join(resRoot, item.name), item.target)
    if (result.extractor === undefined) {
      const reason = result.failures.join('；') || '解压器都不可用'
      failures.push({ archive: item.name, reason })
      report.push(`解压 ${item.name} 失败：${reason}`)
      // 失败留下的空目录清掉，免得花名册里多一只 0 个动画的宠物
      await fsp.rm(item.target, { recursive: true, force: true })
      continue
    }
    await flattenSingleChain(item.target)
    const gifs = (await listGifs(item.target)).length
    if (gifs === 0) {
      failures.push({ archive: item.name, reason: '解压完了但里面没有 GIF' })
      report.push(`解压 ${item.name} 完成，但没找到 GIF`)
      continue
    }
    report.push(`解压 ${item.name} → assets/${item.pet}/（${result.extractor}，${gifs} 个 GIF）`)
    extracted.push({ archive: item.name, pet: item.pet, extractor: result.extractor, gifs })
  }

  return {
    report,
    extracted,
    failures,
    imported: [...new Set(extracted.map((item) => item.pet))],
  }
}
