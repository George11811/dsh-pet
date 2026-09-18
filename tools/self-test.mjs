/**
 * Host 半边自测：不启动 dsh，直接把 lib/index.js 的路由处理器拉起来打几个请求。
 *
 *   node tools/self-test.mjs
 *
 * 为什么需要它：Host 半边是「改代码要重启 dsh 才生效」的那部分，而多宠物目录依赖
 * 新的递归查找。跑一遍这个脚本就能在重启前确认新代码是对的（解析、404、ETag、缓存头）。
 */
import { createRequire } from 'node:module'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsRoot = path.join(packageRoot, 'assets')
const require = createRequire(import.meta.url)

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

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

apply(ctx, { assetDir: assetsRoot, routePrefix: '/fish-pet', cacheSeconds: 60 })
if (registered === null) {
  console.error('apply() 没有注册路由')
  process.exit(1)
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

function request(urlPath, method = 'GET', headers = {}) {
  const req = Object.assign(Readable.from([]), { method, url: urlPath, headers })
  const res = makeResponse()
  return new Promise((resolve, reject) => {
    res.on('finish', () => resolve(res))
    res.on('error', reject)
    Promise.resolve(registered.handler(req, res)).catch(reject)
  })
}

// ── 准备一个两级目录的素材树，验证「按文件名递归查找」 ────────────────────
const probeRoot = path.join(assetsRoot, '__selftest__')
const nested = path.join(probeRoot, 'pack-a', 'inner')
await fsp.mkdir(nested, { recursive: true })
const sample = path.join(assetsRoot, 'fat-fish')
let sampleName = 'sample.gif'
try {
  const found = (await fsp.readdir(sample)).find((name) => name.toLowerCase().endsWith('.gif'))
  if (found !== undefined) sampleName = found
} catch {
  /* 没有素材就用自造的假文件 */
}
const fakeGif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 7)])
await fsp.writeFile(path.join(nested, sampleName), fakeGif)

const cases = []
const encoded = encodeURIComponent(sampleName)

// 1. 扁平文件名 → 递归找到 pack-a/inner 里的那个（关键用例）
const flat = await request(`/fish-pet/${encoded}`)
cases.push([
  '按文件名递归查找',
  flat.statusCode === 200 && flat.headers['content-type'] === 'image/gif',
  `${flat.statusCode} ${flat.headers['content-type']} ${flat.body().length}B`,
])

// 2. 相对路径直接命中
const byPath = await request(`/fish-pet/${encodeURIComponent('__selftest__/pack-a/inner')}/${encoded}`)
cases.push(['按相对路径命中', byPath.statusCode === 200, String(byPath.statusCode)])

// 2b. 两只宠物有同名文件：带目录的 URL 必须各自取到自己的那份（客户端就靠这个）
const twinA = path.join(probeRoot, 'pet-a')
const twinB = path.join(probeRoot, 'pet-b')
await fsp.mkdir(twinA, { recursive: true })
await fsp.mkdir(twinB, { recursive: true })
await fsp.writeFile(path.join(twinA, 'same.gif'), Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(10, 1)]))
await fsp.writeFile(path.join(twinB, 'same.gif'), Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(400, 2)]))
const fromA = await request(`/fish-pet/${encodeURIComponent('__selftest__/pet-a')}/same.gif`)
const fromB = await request(`/fish-pet/${encodeURIComponent('__selftest__/pet-b')}/same.gif`)
cases.push([
  '同名文件按目录区分',
  fromA.statusCode === 200 && fromB.statusCode === 200 && fromA.body().length !== fromB.body().length,
  `${fromA.body().length}B vs ${fromB.body().length}B`,
])

// 3. 目录穿越必须 404
for (const bad of ['/fish-pet/..%2Fpackage.json', '/fish-pet/..%5Cpackage.json', '/fish-pet/%2e%2e/package.json']) {
  const res = await request(bad)
  cases.push([`穿越防护 ${bad}`, res.statusCode === 404, String(res.statusCode)])
}

// 4. 非 gif / 不存在 / 方法不对
cases.push(['非 gif 404', (await request('/fish-pet/package.json')).statusCode === 404, ''])
cases.push(['不存在 404', (await request('/fish-pet/nope.gif')).statusCode === 404, ''])
cases.push(['POST 405', (await request('/fish-pet/x.gif', 'POST')).statusCode === 405, ''])

// 5. 健康检查：animations 应该是整棵素材树的 GIF 数（含自造的那张）
const health = await request('/fish-pet/')
let payload = null
try {
  payload = JSON.parse(health.body().toString('utf8'))
} catch {
  payload = null
}
cases.push([
  '健康检查计数 + version 2',
  health.statusCode === 200 && payload !== null && payload.version === 2 && payload.animations >= 1,
  payload === null ? 'not json' : `animations=${payload.animations} version=${payload.version}`,
])

// 6. ETag / 304
const first = await request(`/fish-pet/${encoded}`)
const etag = first.headers.etag
const cached = await request(`/fish-pet/${encoded}`, 'GET', { 'if-none-match': etag })
cases.push(['ETag 304', first.statusCode === 200 && cached.statusCode === 304, `${first.statusCode}/${cached.statusCode}`])

// 7. HEAD 不带 body 但带 content-length
const head = await request(`/fish-pet/${encoded}`, 'HEAD')
cases.push([
  'HEAD',
  head.statusCode === 200 && head.body().length === 0 && Number(head.headers['content-length']) > 0,
  `status=${head.statusCode} body=${head.body().length}B len=${head.headers['content-length']}`,
])

await fsp.rm(probeRoot, { recursive: true, force: true })

let failed = 0
for (const [label, ok, detail] of cases) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}
console.log(failed === 0 ? `\n全部通过（${cases.length} 项）` : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
