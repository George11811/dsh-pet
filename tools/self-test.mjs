/**
 * Host 半边自测：不启动 dsh，直接把 lib/index.js 的路由处理器拉起来打请求。
 *
 *   node tools/self-test.mjs
 *
 * 为什么需要它：Host 半边是「改代码要重启 dsh 才生效」的那部分，而它是素材解析、
 * 运行时花名册、面板导入的执行者。跑一遍这个脚本就能在重启前确认新代码是对的：
 * 递归查找、404/405、ETag、健康检查、__roster 数据结构、__import 的挡板与真实解压。
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsRoot = path.join(packageRoot, 'assets')
const require = createRequire(import.meta.url)
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

/** 起一个 Host 半边实例，返回它注册的路由。 */
function boot(config) {
  let registered = null
  const ctx = {
    webServer: {
      register(route) {
        registered = route
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, config)
  if (registered === null) throw new Error('apply() 没有注册路由')
  return registered
}

/** 假响应：收集状态码/头/字节数，兼容 stream.pipe()。 */
function makeResponse() {
  const chunks = []
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk)
      callback()
    },
  })
  sink.statusCode = 0
  sink.headers = {}
  sink.headersSent = false
  sink.writeHead = (status, headers) => {
    sink.statusCode = status
    sink.headers = headers || {}
    sink.headersSent = true
  }
  sink.body = () => Buffer.concat(chunks)
  return sink
}

function call(route, urlPath, method = 'GET', headers = {}, body = '') {
  const req = Object.assign(Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')]), {
    method,
    url: urlPath,
    headers,
  })
  const res = makeResponse()
  return new Promise((resolve, reject) => {
    res.on('finish', () => resolve(res))
    res.on('error', reject)
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

function json(res) {
  try {
    return JSON.parse(res.body().toString('utf8'))
  } catch {
    return null
  }
}

const route = boot({ assetDir: assetsRoot, routePrefix: '/fish-pet', cacheSeconds: 60 })

// ── 准备一个两级目录的素材树，验证「按文件名递归查找」 ────────────────────
const probeRoot = path.join(assetsRoot, '__selftest__')
const nested = path.join(probeRoot, 'pack-a', 'inner')
await fsp.mkdir(nested, { recursive: true })
const sample = path.join(assetsRoot, 'fat-fish')
let sampleName = 'sample.gif'
let realGifs = []
try {
  realGifs = (await fsp.readdir(sample)).filter((name) => name.toLowerCase().endsWith('.gif'))
  if (realGifs.length > 0) sampleName = realGifs[0]
} catch {
  /* 没有素材就用自造的假文件 */
}
const fakeGif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 7)])
await fsp.writeFile(path.join(nested, sampleName), fakeGif)

const cases = []
const encoded = encodeURIComponent(sampleName)

// 1. 扁平文件名 → 递归找到 pack-a/inner 里的那个（关键用例）
const flat = await call(route, `/fish-pet/${encoded}`)
cases.push([
  '按文件名递归查找',
  flat.statusCode === 200 && flat.headers['content-type'] === 'image/gif',
  `${flat.statusCode} ${flat.headers['content-type']} ${flat.body().length}B`,
])

// 2. 相对路径直接命中
const byPath = await call(route, `/fish-pet/${encodeURIComponent('__selftest__/pack-a/inner')}/${encoded}`)
cases.push(['按相对路径命中', byPath.statusCode === 200, String(byPath.statusCode)])

// 2b. 两只宠物有同名文件：带目录的 URL 必须各自取到自己的那份（客户端就靠这个）
const twinA = path.join(probeRoot, 'pet-a')
const twinB = path.join(probeRoot, 'pet-b')
await fsp.mkdir(twinA, { recursive: true })
await fsp.mkdir(twinB, { recursive: true })
await fsp.writeFile(path.join(twinA, 'same.gif'), Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(10, 1)]))
await fsp.writeFile(path.join(twinB, 'same.gif'), Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(400, 2)]))
const fromA = await call(route, `/fish-pet/${encodeURIComponent('__selftest__/pet-a')}/same.gif`)
const fromB = await call(route, `/fish-pet/${encodeURIComponent('__selftest__/pet-b')}/same.gif`)
cases.push([
  '同名文件按目录区分',
  fromA.statusCode === 200 && fromB.statusCode === 200 && fromA.body().length !== fromB.body().length,
  `${fromA.body().length}B vs ${fromB.body().length}B`,
])

// 3. 目录穿越必须 404
for (const bad of ['/fish-pet/..%2Fpackage.json', '/fish-pet/..%5Cpackage.json', '/fish-pet/%2e%2e/package.json']) {
  const res = await call(route, bad)
  cases.push([`穿越防护 ${bad}`, res.statusCode === 404, String(res.statusCode)])
}

// 4. 非 gif / 不存在 / 方法不对
cases.push(['非 gif 404', (await call(route, '/fish-pet/package.json')).statusCode === 404, ''])
cases.push(['不存在 404', (await call(route, '/fish-pet/nope.gif')).statusCode === 404, ''])
cases.push(['POST 405', (await call(route, '/fish-pet/x.gif', 'POST')).statusCode === 405, ''])

// 5. 健康检查：animations 应该是整棵素材树的 GIF 数（含自造的那张）
const health = await call(route, '/fish-pet/')
const payload = json(health)
cases.push([
  '健康检查计数 + version 3',
  health.statusCode === 200 && payload !== null && payload.version === 3 && payload.animations >= 1,
  payload === null ? 'not json' : `animations=${payload.animations} version=${payload.version}`,
])
cases.push([
  '健康检查带花名册信息',
  payload !== null && payload.roster !== undefined && Array.isArray(payload.pendingImports) && payload.roster.path === '/fish-pet/__roster',
  payload === null ? 'not json' : `roster=${payload.roster && payload.roster.path}`,
])

// 6. ETag / 304
const first = await call(route, `/fish-pet/${encoded}`)
const etag = first.headers.etag
const cached = await call(route, `/fish-pet/${encoded}`, 'GET', { 'if-none-match': etag })
cases.push(['ETag 304', first.statusCode === 200 && cached.statusCode === 304, `${first.statusCode}/${cached.statusCode}`])

// 7. HEAD 不带 body 但带 content-length
const head = await call(route, `/fish-pet/${encoded}`, 'HEAD')
cases.push([
  'HEAD',
  head.statusCode === 200 && head.body().length === 0 && Number(head.headers['content-length']) > 0,
  `status=${head.statusCode} body=${head.body().length}B len=${head.headers['content-length']}`,
])

// ── 8. 运行时花名册 ───────────────────────────────────────────────────────
const rosterRes = await call(route, '/fish-pet/__roster')
const roster = json(rosterRes)
const fatFish = roster && Array.isArray(roster.pets) ? roster.pets.find((pet) => pet.id === 'fat-fish') : null
cases.push([
  '__roster 200 + JSON',
  rosterRes.statusCode === 200 && roster !== null && roster.source === 'runtime' && roster.version === 3,
  roster === null ? 'not json' : `source=${roster.source} v=${roster.version}`,
])
cases.push([
  '__roster 宠物与动画对得上',
  roster !== null && fatFish !== undefined && fatFish !== null && roster.assets.length === roster.pets.reduce((sum, pet) => sum + pet.count, 0),
  roster === null ? 'not json' : `pets=${roster.pets.map((pet) => `${pet.id}(${pet.count})`).join('、')}`,
])
const POOL_KEYS = ['think', 'work', 'attention', 'celebrate', 'notify', 'moe', 'hold', 'drop', 'sleep', 'eat', 'sing', 'slack', 'daze', 'mischief', 'roam']
const fatPools = roster && roster.pools ? roster.pools['fat-fish'] : null
cases.push([
  '__roster 池子齐全',
  fatPools != null && POOL_KEYS.every((key) => Array.isArray(fatPools[key])),
  fatPools == null ? 'missing' : POOL_KEYS.map((key) => `${key}=${fatPools[key].length}`).join(' '),
])
const firstAsset = roster && Array.isArray(roster.assets) ? roster.assets[0] : null
const assetHit = firstAsset === null ? null : await call(route, `/fish-pet/${firstAsset.u}`)
cases.push([
  '__roster 里的 URL 片段真的能取到图',
  assetHit !== null && assetHit.statusCode === 200 && assetHit.body().length > 0,
  assetHit === null ? 'no asset' : `${firstAsset.u} → ${assetHit.statusCode} ${assetHit.body().length}B`,
])
cases.push([
  '__roster 带 res/ 状态',
  roster !== null && roster.res !== null && typeof roster.res === 'object' && Array.isArray(roster.res.pending),
  roster === null ? 'not json' : `pending=${(roster.res.pending || []).length}`,
])
const rosterHead = await call(route, '/fish-pet/__roster', 'HEAD')
cases.push(['__roster HEAD 不带 body', rosterHead.statusCode === 200 && rosterHead.body().length === 0, String(rosterHead.statusCode)])
cases.push([
  '__roster 不吃 __selftest__ 内部目录',
  roster !== null && roster.pets.every((pet) => !pet.id.startsWith('__')),
  roster === null ? 'not json' : roster.pets.map((pet) => pet.id).join('、'),
])

// ── 9. __import 的挡板 ────────────────────────────────────────────────────
cases.push(['GET __import 405', (await call(route, '/fish-pet/__import')).statusCode === 405, ''])
cases.push([
  '__import 缺自定义头 → 403',
  (await call(route, '/fish-pet/__import', 'POST', { 'content-type': 'application/json' }, '{}')).statusCode === 403,
  '',
])
cases.push([
  '__import 跨源 → 403',
  (
    await call(
      route,
      '/fish-pet/__import',
      'POST',
      { 'content-type': 'application/json', 'x-fish-pet': 'import', origin: 'http://evil.example', host: '127.0.0.1:3080' },
      '{}',
    )
  ).statusCode === 403,
  '',
])

// ── 10. 真正的导入：临时 res/ + assets/，造一个 zip 走一遍 /__import ──────
const stageRoot = path.join(packageRoot, '.demo-stage', 'selftest-import')
await fsp.rm(stageRoot, { recursive: true, force: true })
const tmpRes = path.join(stageRoot, 'res')
const tmpAssets = path.join(stageRoot, 'assets')
const srcDir = path.join(stageRoot, 'src')
await fsp.mkdir(tmpRes, { recursive: true })
await fsp.mkdir(tmpAssets, { recursive: true })
await fsp.mkdir(srcDir, { recursive: true })

// 用真 GIF（7z 要能压、扫描要能读出一轮时长），名字按池子表起，顺带验证分池。
const packNames = ['demo-cat_思考(认真地).gif', 'demo-cat_打字(普通).gif']
// 7z 不一定在 PATH 上（这台机器就没在），所以和 lib/catalog.mjs 一样列几个候选。
const ZIPPER = ['7z', 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe', '7za']
let zipReady = false
if (realGifs.length >= 2) {
  await fsp.copyFile(path.join(sample, realGifs[0]), path.join(srcDir, packNames[0]))
  await fsp.copyFile(path.join(sample, realGifs[1]), path.join(srcDir, packNames[1]))
  const zipPath = path.join(tmpRes, 'demo-cat.zip')
  for (const zipper of ZIPPER) {
    // 注意不传 windowsHide：这个沙箱里它会让 7z.exe 以 0xC0000142 退出。
    const zipped = spawnSync(zipper, ['a', '-tzip', '-bso0', '-bsp0', zipPath, '.'], { cwd: srcDir, stdio: 'ignore' })
    if (zipped.error === undefined && zipped.status === 0) {
      zipReady = true
      break
    }
  }
}

if (!zipReady) {
  cases.push(['（跳过）真实导入链路：没有可用的 7z / 素材', true, 'skipped'])
} else {
  const tmpRoute = boot({ assetDir: tmpAssets, resDir: tmpRes, routePrefix: '/fish-pet', cacheSeconds: 60 })
  const before = json(await call(tmpRoute, '/fish-pet/__roster'))
  cases.push([
    '临时素材目录一开始是空的',
    before !== null && before.pets.length === 0 && before.res.pending.length === 1,
    before === null ? 'not json' : `pets=${before.pets.length} pending=${before.res.pending.join('、')}`,
  ])

  const imported = json(
    await call(
      tmpRoute,
      '/fish-pet/__import',
      'POST',
      { 'content-type': 'application/json', 'x-fish-pet': 'import', host: '127.0.0.1:3080' },
      JSON.stringify({ force: false }),
    ),
  )
  cases.push([
    '__import 解压出新宠物',
    imported !== null && Array.isArray(imported.imported) && imported.imported.join() === 'demo-cat' && imported.pets.length === 1,
    imported === null ? 'not json' : `imported=${(imported.imported || []).join('、')} pets=${(imported.pets || []).map((pet) => `${pet.id}(${pet.count})`).join('、')}`,
  ])
  // 池子里存的是真实相对路径，显示名（去掉宠物前缀和时间戳之后）才是池子表里的名字。
  const assetByFile = new Map((imported && imported.assets ? imported.assets : []).map((asset) => [asset.f, asset]))
  const inPool = (key, display) => ((imported && imported.pools['demo-cat'][key]) || []).some((f) => {
    const asset = assetByFile.get(f)
    return asset !== undefined && asset.n === display
  })
  cases.push([
    '__import 按名字分了池子',
    imported !== null && inPool('think', '思考(认真地)') && inPool('work', '打字(普通)'),
    imported === null
      ? 'not json'
      : `think=[${(imported.pools['demo-cat'].think || []).join('、')}] work=[${(imported.pools['demo-cat'].work || []).join('、')}]`,
  ])
  cases.push([
    '__import 后 res 不再待导入',
    imported !== null && imported.res.pending.length === 0 && imported.res.archives[0].extracted === true,
    imported === null ? 'not json' : `pending=${(imported.res.pending || []).length} extracted=${imported.res.archives[0] && imported.res.archives[0].extracted}`,
  ])

  // 新宠物的图必须马上能通过路由取到（客户端切过去就有图）
  const newAsset = imported && imported.assets.find((asset) => asset.pet === 'demo-cat')
  const newHit = newAsset ? await call(tmpRoute, `/fish-pet/${newAsset.u}`) : null
  cases.push([
    '导入的图立刻可取',
    newHit !== null && newHit.statusCode === 200 && newHit.body().length > 0,
    newHit === null ? 'no asset' : `${newAsset.u} → ${newHit.statusCode} ${newHit.body().length}B`,
  ])
  cases.push([
    '导入的动画有一轮时长（为了落地动作播完整段）',
    newAsset !== null && newAsset !== undefined && newAsset.ms >= 600,
    newAsset === undefined || newAsset === null ? 'no asset' : `ms=${newAsset.ms}`,
  ])

  const again = json(
    await call(
      tmpRoute,
      '/fish-pet/__import',
      'POST',
      { 'content-type': 'application/json', 'x-fish-pet': 'import', host: '127.0.0.1:3080' },
      '{}',
    ),
  )
  cases.push([
    '重复导入不重复解压',
    again !== null && again.imported.length === 0 && again.report.some((line) => line.includes('跳过')),
    again === null ? 'not json' : (again.report || []).join(' / '),
  ])

  const forced = json(
    await call(
      tmpRoute,
      '/fish-pet/__import',
      'POST',
      { 'content-type': 'application/json', 'x-fish-pet': 'import', host: '127.0.0.1:3080' },
      JSON.stringify({ force: true }),
    ),
  )
  cases.push([
    'force 会重新解压',
    forced !== null && forced.imported.join() === 'demo-cat',
    forced === null ? 'not json' : `imported=${(forced.imported || []).join('、')}`,
  ])

  // 非法包名（以 __ 开头）不该被当成宠物
  await fsp.copyFile(path.join(tmpRes, 'demo-cat.zip'), path.join(tmpRes, '__bad.zip'))
  const bad = json(
    await call(
      tmpRoute,
      '/fish-pet/__import',
      'POST',
      { 'content-type': 'application/json', 'x-fish-pet': 'import', host: '127.0.0.1:3080' },
      '{}',
    ),
  )
  cases.push([
    '非法包名被挡下并说明原因',
    bad !== null && bad.failures.some((item) => item.archive === '__bad.zip') && bad.pets.every((pet) => pet.id !== '__bad'),
    bad === null ? 'not json' : `failures=${(bad.failures || []).map((item) => item.archive).join('、')}`,
  ])
}

await fsp.rm(probeRoot, { recursive: true, force: true })
await fsp.rm(stageRoot, { recursive: true, force: true })

let failed = 0
for (const [label, ok, detail] of cases) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}
console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
