/**
 * 蓝色大肥鱼桌宠 —— Host 半边。
 *
 * 只做一件事：把素材目录里的 GIF 以 HTTP 路由暴露给浏览器，
 * 让 Client 半边可以用 <img src> 直接显示（浏览器自己缓存、自己流式解码），
 * 而不必把几 MB 的图片塞进 JSON RPC。
 *
 * 素材目录默认是包内的 `assets/`（用户把桌宠压缩包丢在这里，由
 * tools/build-client.mjs 解压），也支持子目录 —— 桌宠包通常自带一层目录。
 * 解析规则：
 *   1) `GET <prefix>/<相对路径>` 直接命中；
 *   2) 否则按「文件名」在整棵素材树里找（扁平 URL 也能用）。
 * 目录外的路径、非 .gif、含分隔符/`..` 的名字一律 404，不做目录穿越。
 */
import { spawn } from 'node:child_process'
import { createReadStream, promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Host 半边在 webServer 就绪后才激活。 */
export const inject = ['webServer']

/** 压缩包后缀（和 tools/build-client.mjs 保持一致）。 */
const ARCHIVE_EXTENSIONS = ['.7z', '.zip', '.rar', '.tar', '.gz', '.tgz']

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** 缺省素材目录：包内的 assets/（运行时素材，由生成脚本从 res/ 解压而来）。 */
function defaultAssetRoot() {
  return path.join(packageRoot(), 'assets')
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const assetRoot = path.resolve(
    typeof raw.assetDir === 'string' && raw.assetDir.trim() !== '' ? raw.assetDir : defaultAssetRoot(),
  )
  const resRoot = path.resolve(
    typeof raw.resDir === 'string' && raw.resDir.trim() !== '' ? raw.resDir : path.join(packageRoot(), 'res'),
  )
  const rawPrefix = typeof raw.routePrefix === 'string' && raw.routePrefix.trim() !== '' ? raw.routePrefix.trim() : '/fish-pet'
  const routePrefix = `/${rawPrefix.replace(/^\/+|\/+$/g, '')}`
  const cacheSeconds = Number.isFinite(raw.cacheSeconds) ? Math.max(0, Math.floor(raw.cacheSeconds)) : 604800
  // 可选：assets/ 空的时候自动跑一次生成脚本（解压 res/ 里的压缩包 + 重新生成客户端数据）。
  const buildOnStart = raw.buildOnStart === true
  return { assetRoot, resRoot, routePrefix, cacheSeconds, buildOnStart }
}

function send(res, status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

export function apply(ctx, config) {
  const { assetRoot, resRoot, routePrefix, cacheSeconds, buildOnStart } = normalizeConfig(config)

  /** 谁在取图：用来判断「浏览器真的把桌宠画出来了」，而不只是注册成功。 */
  const stats = { assetHits: 0, browserHits: 0, lastAsset: null, lastAssetAt: null, lastUserAgent: null }
  function noteHit(req, name) {
    const agent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''
    stats.assetHits += 1
    if (!/powershell|curl|node|python/i.test(agent)) stats.browserHits += 1
    stats.lastAsset = name
    stats.lastAssetAt = new Date().toISOString()
    stats.lastUserAgent = agent.slice(0, 160)
  }

  /**
   * 整棵素材树的索引：文件名 → 相对路径（POSIX 分隔符）。
   * 缓存 10 秒，解压出新素材后自动跟上。
   */
  const indexCache = { at: 0, files: new Map() }
  async function indexFiles(force) {
    if (force !== true && Date.now() - indexCache.at < 10000) return indexCache.files
    const files = new Map()
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
        else if (/\.gif$/i.test(entry.name) && !files.has(entry.name)) files.set(entry.name, relative)
      }
    }
    await walk(assetRoot, '')
    indexCache.at = Date.now()
    indexCache.files = files
    return files
  }

  async function statGif(full) {
    try {
      const info = await fsp.stat(full)
      if (!info.isFile()) return undefined
      return { full, size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return undefined
    }
  }

  /**
   * 把 URL 路径解析成一个真实的 GIF 文件；任何可疑输入返回 undefined。
   * @param {string} pathname 请求路径名。
   * @returns {Promise<{full: string, size: number, mtimeMs: number} | undefined>}
   */
  async function resolveAsset(pathname) {
    if (pathname !== routePrefix && !pathname.startsWith(`${routePrefix}/`)) return undefined
    let name = pathname.slice(routePrefix.length).replace(/^\/+/, '')
    if (name === '') return undefined
    try {
      name = decodeURIComponent(name)
    } catch {
      return undefined
    }
    if (!/\.gif$/i.test(name) || name.includes('\0')) return undefined
    const segments = name.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
      return undefined
    }

    // 1) 直接按相对路径找
    const direct = path.resolve(assetRoot, ...segments)
    if (direct.startsWith(`${assetRoot}${path.sep}`)) {
      const found = await statGif(direct)
      if (found !== undefined) return found
    }

    // 2) 按文件名在整棵树里找（用户可能只给文件名）
    const files = await indexFiles(false)
    const relative = files.get(segments[segments.length - 1])
    if (relative === undefined) return undefined
    return statGif(path.resolve(assetRoot, ...relative.split('/')))
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: routePrefix,
      async handler(req, res) {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const pathname = url.pathname

          // 路由根：给一个不含绝对路径的健康检查，方便确认 Host 半边活着。
          if (pathname === routePrefix || pathname === `${routePrefix}/`) {
            const files = await indexFiles(true)
            const animations = files.size
            const resArchives = await countArchives()
            send(res, animations > 0 ? 200 : 500, {
              ok: animations > 0,
              version: 2,
              route: routePrefix,
              assetRoot: path.basename(assetRoot),
              recursive: true,
              animations,
              // 没素材但 res/ 里有压缩包 = 需要跑一次生成脚本
              needsBuild: animations === 0,
              resArchives,
              buildOnStart,
              pets: petsOnDisk(files),
              cacheSeconds,
              stats,
            })
            return
          }

          const asset = await resolveAsset(pathname)
          if (asset === undefined) {
            send(res, 404, 'not found')
            return
          }
          noteHit(req, path.relative(assetRoot, asset.full))

          const etag = `W/"${asset.size.toString(16)}-${Math.floor(asset.mtimeMs).toString(16)}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': `public, max-age=${cacheSeconds}` })
            res.end()
            return
          }

          const headers = {
            'content-type': 'image/gif',
            'content-length': asset.size,
            'cache-control': `public, max-age=${cacheSeconds}`,
            etag,
            'last-modified': new Date(asset.mtimeMs).toUTCString(),
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, headers)
            res.end()
            return
          }
          res.writeHead(200, headers)
          const stream = createReadStream(asset.full)
          stream.on('error', () => res.destroy())
          stream.pipe(res)
        } catch (error) {
          ctx.logger?.warn?.('fish-pet asset request failed: %s', error instanceof Error ? error.message : String(error))
          if (!res.headersSent) send(res, 500, 'internal error')
          else res.destroy()
        }
      },
    }),
  )

  ctx.logger?.info?.('fish-pet assets served from %s at %s', assetRoot, routePrefix)

  // ── 启动自检 ────────────────────────────────────────────────────────────
  // 素材是「构建产物」：解压 res/ 里的压缩包 + 重新生成 lib/client.js 由
  // tools/build-client.mjs 完成。重启 dsh 不会做这件事，所以这里至少要把话说清楚：
  // assets/ 空的时候，要么按配置自动构建一次，要么明确告诉用户跑哪条命令。
  void (async () => {
    try {
      const files = await indexFiles(true)
      if (files.size > 0) return
      const archives = await countArchives()
      if (archives === 0) {
        ctx.logger?.warn?.(
          'fish-pet: 没有素材，%s 里也没有压缩包。把桌宠包（.7z/.zip）放进 res/ 再跑 node tools/build-client.mjs。',
          resRoot,
        )
        return
      }
      if (buildOnStart) {
        ctx.logger?.info?.('fish-pet: assets/ 是空的，按 buildOnStart 自动构建（res/ 有 %d 个压缩包）', archives)
        const result = await runBuildScript()
        await indexFiles(true)
        if (result.ok) ctx.logger?.info?.('fish-pet: 自动构建完成，刷新页面即可看到素材')
        else ctx.logger?.warn?.('fish-pet: 自动构建失败（%s）；手动跑 node tools/build-client.mjs 看原因', result.reason)
        return
      }
      ctx.logger?.warn?.(
        'fish-pet: assets/ 里没有素材，但 res/ 有 %d 个压缩包。跑 node tools/build-client.mjs 解压并生成客户端数据，然后刷新页面（重启 dsh 不会自动做这一步；也可以把 config.buildOnStart 设为 true 让它以后自动做）。',
        archives,
      )
    } catch (error) {
      ctx.logger?.warn?.('fish-pet: 启动自检失败：%s', error instanceof Error ? error.message : String(error))
    }
  })()

  /** 数一数 res/ 里有多少个压缩包。 */
  async function countArchives() {
    try {
      const entries = await fsp.readdir(resRoot, { withFileTypes: true })
      return entries.filter((entry) => entry.isFile() && ARCHIVE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
        .length
    } catch {
      return 0
    }
  }

  /** 从索引里归纳出宠物目录（顶层目录名）。 */
  function petsOnDisk(files) {
    const pets = new Set()
    for (const relative of files.values()) {
      const slash = relative.indexOf('/')
      pets.add(slash === -1 ? 'default' : relative.slice(0, slash))
    }
    return [...pets].sort()
  }

  /** 跑一次生成脚本（构建：解压 res/ → assets/，并重新生成 lib/client.js）。 */
  function runBuildScript() {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(process.execPath, [path.join(packageRoot(), 'tools', 'build-client.mjs')], {
          cwd: packageRoot(),
          stdio: 'ignore',
        })
      } catch (error) {
        resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) })
        return
      }
      child.on('error', (error) => resolve({ ok: false, reason: error.message }))
      child.on('exit', (code) => resolve({ ok: code === 0, reason: `exit ${code}` }))
    })
  }
}
