/**
 * 蓝色大肥鱼桌宠 —— Client 半边。
 *
 * 这是模板：`const BUILT_PETS = …` / `const BUILT_ASSETS = …` / `const BUILT_POOLS = …` /
 * `const BASE = …` 四行由 tools/build-client.mjs 用素材目录的真实内容重写，产物是
 * lib/client.js（浏览器实际加载的文件）。改交互改这里，然后重新构建。
 *
 * 这四行只是**兜底数据**：组件挂载后会向 Host 要一份运行时花名册
 * （GET BASE/__roster），拿到就整体替换 —— 所以加新宠物不必重新构建，
 * 在面板里点「导入 / 重扫」即可（Host 和构建脚本共用 lib/catalog.mjs 的扫描逻辑）。
 *
 * 素材靠 Host 半边的 HTTP 路由提供，这里只拼 URL，不搬字节。
 *
 * ── 状态机 ──────────────────────────────────────────────────────────────
 * 世界状态（DSH 给的，来自 shell.overlay 槽的 useSessionStatus 标准 props）：
 *   attention  有会话在等你回答（审批/提问）
 *   running    有会话正在干活
 *   done       有后台会话刚干完、还没看过
 *   idle       什么都没发生
 *
 * 宠物状态（优先级从高到低）：
 *   pin        面板里点选了某个动画 → 一直播它
 *   drag       被拖来拖去 → 紧张/害怕
 *   poke       被点了一下 → 卖萌几秒，然后回到世界状态
 *   celebrate  刚干完活的那一下 → 庆祝几秒
 *   世界状态   attention / running(先思考后打字) / done(通知提示)
 *   idle       过「生活」：睡觉、干饭、唱歌、摸鱼、发呆、搞事、瞎逛，
 *              每段生活持续几十秒到几分钟，而不是一首一首换歌
 */
window.__ModuleLoader__.load({
  id: 'dsh-fish-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 构建时写进来的花名册（离线兜底）：{ id, label, count } */
    const BUILT_PETS = /* @__PETS__@ */ []
    /** 构建时写进来的动画：{ f: 相对路径, u: URL 片段, n: 显示名, ms: 一轮时长, pet: 属于哪只宠物 } */
    const BUILT_ASSETS = /* @__ANIMATIONS__@ */ []
    /** 构建时写进来的池子：petId → { 池名: [f, ...] } */
    const BUILT_POOLS = /* @__POOLS__@ */ {}
    const BASE = /* @__BASE__@ */ '/fish-pet'
    const STORAGE_KEY = 'dsh-fish-pet:v1'

    /**
     * 台词库：池名 → 台词数组。
     * 池名和状态机的状态一一对应（think/work/attention/done + 七种「生活」），
     * 另外 poke/hold/drop/pin/show/muse 是交互和自言自语用的。
     * `{n}` 会在说话时替换成真实信息（等你的活儿数 / 会话总数）。
     * 这里不走 locale 服务：数量多、还带整句，直接按当前语言选一张表更省事。
     */
    const PHRASES = {
      zh: {
        sleep: ['呼……呼……（其实在假装工作）', '别叫我，我在跟周公对齐需求', '睡觉是最好的性能优化', '再睡五分钟就起来写代码', '梦里没有 bug'],
        eat: ['干饭时间到，谁也别拦我', '吃点西瓜，给 GPU 降降温', '甜甜圈和代码更配哦', '我不饿，我只是嘴馋', '先吃一口，需求稍后再说'],
        sing: ['啦啦啦～今天的编译一定过', '唱歌有益身心健康', '蹦迪使我快乐', '这首歌是写给没写完的测试的', '谁在听我唱，举个手'],
        slack: ['带薪拉屎，人生乐事', '我就摸一会儿鱼……哦我本来就是鱼', '摸鱼是对抗焦虑的良药', '老板路过记得叫我', '这个需求我先想想（其实在打游戏）'],
        daze: ['发呆中，请勿打扰', '在想一个很深的问题：今天吃什么', '大脑正在 GC', '你看我是不是有点圆', '什么都没想，脑子很干净'],
        mischief: ['嘿嘿，偷偷搞点事', '我把你的光标藏起来了（骗你的）', '皮一下很开心', '别拦我，我要开始整活了', '这个 bug 一定是别人的'],
        roam: ['到处看看有没有好吃的', '巡逻中，一切正常', '咦，这里怎么有个 TODO', '我溜达一圈就回来'],
        think: ['让我想想……这个循环为什么死不掉', '正在思考（其实在发呆）', '嗯……先看日志', '这个报错我见过（没见过）'],
        work: ['开始动手了，别催', '键盘都要敲冒烟了', '这个 bug 拆起来挺费劲', '干活中，请勿投喂', '让我把这个函数砍成三段'],
        attention: ['在等你点头呢', '有 {n} 个地方等你拍板', '你点一下我才能继续呀', '命令我，快', '审批按钮就在那边', '点点这里嘛，就一下', '我等你等到长蘑菇了'],
        done: ['刚干完一个，去看看？', '活儿交了，验收一下', '干完了！我要掌声', '那边收工了，别忘了', '验收一下嘛，我干得很认真的'],
        poke: ['干嘛呀，戳我', '哎呀呀，人家会害羞的啦', '再戳我就咬你哦，真的咬', '摸摸头也是可以的嘛', '你是不是没活干了', '呜哇，被戳到了', '你戳我一下，我开心一下'],
        hold: ['呜哇——放我下来！我怕高', '救命，我恐高啊', '你要把我扔哪去', '别晃了别晃了，晕', '我、我抓紧了！'],
        drop: ['呜……你摔我', '我就知道你不要我了', '好疼，要抱抱', '哼，我记住了', '你、你都不接住我'],
        pin: ['好，我就一直这样', '你说了算', '那我定格了', '喜欢这个是吧，那我一直摆着'],
        show: ['我回来了！想我没', '终于想起我了', '藏这么久都不找我', '重见天日'],
        switchPet: ['换成 {x} 了', '好，现在就由 {x} 值班', '{x} 上线！', '交接完毕：{x}'],
        imported: ['新伙伴 {x} 到岗了', '收到 {x} 这个新素材包', '解压好了，以后也能变成 {x}'],
        report: ['这次干了 {t}，写了 {o} tokens', '收工：{t} / {o} tokens，累死我了', '报告：耗时 {t}，输出 {o} tokens（总 {a}）', '干完啦，{t}、{o} tokens，值不值？'],
        reportTime: ['这次干了 {t}', '收工，耗时 {t}', '活儿交了，{t} 搞定'],
        // 干活期间的实时播报（按事件流）
        mThink: ['让我捋一捋…', '这个逻辑有点绕', '嗯……先看看现场', '有点眉目了', '唔…有点难'],
        mWrite: ['开始写结论了', '把思路整理一下', '这就写下来'],
        mRead: ['翻一下 {x}', '我看看这个文件', '在读 {x} 了'],
        mSearch: ['在找 {x}', '搜一下看看有几处', '这东西藏哪了…'],
        mEdit: ['动手改 {x}', '这行改一下就对了', '开始写代码了'],
        mRun: ['跑一下 {x}', '命令走你', '看看跑不跑得通'],
        mWeb: ['查一下资料', '我去网上看看', '搜搜有没有人踩过这个坑'],
        mPlan: ['先理一下步骤', '把清单更新一下', '计划是这样的…'],
        mLearn: ['翻翻技能手册', '让我看看有没有现成的招'],
        mDelegate: ['派个小弟去干', '这事分包出去', '叫人帮忙了'],
        mAsk: ['这个得问你', '我先确认一下再动手'],
        mPlugin: ['鼓捣一下插件', '在给运行时做手术'],
        mTool: ['用一下 {x}', '来点工具活'],
        mOk: ['过了', '嗯，符合预期', '这条通了', '不错不错', '嘿嘿，又过一关'],
        mFail: ['咦，报错了', '这条路堵了，换一条', '不对不对，重来', '失败也是一种信息'],
        mFailWhy: ['报错了：{r}', '工具回我：{r}', '嗯…{r}，我换个法子', '呜……{r}'],
        muse: ['今天有 {n} 个会话陪着我', '你写代码的样子真帅', '要不要休息一下？喝口水', '我盯你很久了', '这个项目什么时候上线呀'],
        // 待回答问题（方案 B）：题目挂上来时说 answering，用户点了选项说 answered。
        answering: ['选一个嘛，我帮你回', '这题要你点一下：{q}', '你选哪个？我这就去答', '决定权在你手上'],
        answered: ['好，我回了！', '收到，就这个', '答完啦，继续干活', '嗯，我替你点了'],
      },
      en: {
        sleep: ['Zzz… (pretending to work)', 'Dont wake me, I am aligning requirements with Morpheus', 'Sleep is the best performance optimization', 'Five more minutes, then I write code'],
        eat: ['Snack time, nobody stop me', 'Watermelon, to cool the GPU down', 'Donuts pair well with code', 'Not hungry, just greedy'],
        sing: ['La la la~ today it compiles', 'Singing is good for your health', 'Dancing makes me happy', 'This song is for the tests I never wrote'],
        slack: ['Paid bathroom break, a simple joy', 'Slacking off a bit… I am literally a fish', 'Slacking is an anti-anxiety drug', 'Tell me if the boss walks by'],
        daze: ['Spacing out, do not disturb', 'Thinking deep: what to eat today', 'Brain is running GC', 'Do I look a bit round?'],
        mischief: ['Hehe, causing a little trouble', 'I hid your cursor (just kidding)', 'Being naughty feels great', 'Step aside, mischief mode on'],
        roam: ['Looking around for snacks', 'Patrolling, all clear', 'Oh, a TODO over here', 'Just wandering nearby'],
        think: ['Let me think… why wont this loop die', 'Thinking hard (actually spacing out)', 'Hmm… lets read the logs first', 'I have seen this error before (I have not)'],
        work: ['Hands on now, dont rush me', 'The keyboard is smoking', 'This bug is stubborn', 'Working, do not feed me'],
        attention: ['Waiting for your nod', '{n} things need your call', 'Click it so I can continue', 'Command me, quick'],
        done: ['Just finished one, take a look?', 'Delivered, please review', 'Done! I want applause', 'That one wrapped up', 'Please review it, I worked hard'],
        poke: ['What? You poked me', 'Aw, I am shy', 'Poke me again and I bite', 'Head pats are fine too', 'Ouch, poked', 'Poke me once, happy once'],
        hold: ['Whoa — put me down! I fear heights', 'Help, I am scared of heights', 'Where are you taking me', 'Stop swinging, I am dizzy', 'I, I am holding on!'],
        drop: ['Ouch… you dropped me', 'I knew you did not want me', 'It hurts, hug me', 'Hmph, noted', 'You, you did not catch me'],
        pin: ['Fine, I will stay like this', 'Your call', 'Frozen then', 'You like this one, so I hold it'],
        show: ['I am back! Missed me?', 'Finally you remembered me', 'So long and you did not look', 'Back to daylight'],
        switchPet: ['Switched to {x}', 'Fine, {x} is on duty now', '{x} is online!', 'Handover done: {x}'],
        imported: ['New buddy {x} is on duty', 'Got the {x} pack', 'Extracted — {x} can join from now on'],
        report: ['That took {t} and {o} tokens', 'Done: {t} / {o} tokens, I am tired', 'Report: {t}, {o} output tokens ({a} total)', 'All done in {t} for {o} tokens'],
        reportTime: ['That took {t}', 'Done in {t}', 'Wrapped up in {t}'],
        // live play-by-play while working (driven by the session event stream)
        mThink: ['Let me untangle this', 'This logic is twisty', 'Hmm… let me look at the scene', 'Getting somewhere', 'Hmm… this one is hard'],
        mWrite: ['Writing the conclusion', 'Tidying up my thoughts', 'Putting it down now'],
        mRead: ['Checking {x}', 'Let me look at this file', 'Reading {x} now'],
        mSearch: ['Looking for {x}', 'Let me search around', 'Where is that thing hiding…'],
        mEdit: ['Editing {x}', 'One line and it is fixed', 'Writing code now'],
        mRun: ['Running {x}', 'Command, go', 'Let us see if it passes'],
        mWeb: ['Looking it up online', 'Checking the web', 'Someone must have hit this before'],
        mPlan: ['Let me plan the steps', 'Updating the list', 'Here is the plan…'],
        mLearn: ['Checking the skill book', 'Any existing trick for this?'],
        mDelegate: ['Sending a helper', 'Subcontracting this one', 'Calling for backup'],
        mAsk: ['This one is yours to answer', 'Let me confirm before acting'],
        mPlugin: ['Poking the plugin system', 'Surgery on the runtime'],
        mTool: ['Using {x}', 'Some tool work now'],
        mOk: ['It passed', 'As expected', 'That one worked', 'Nice', 'Hehe, another one down'],
        mFail: ['Uh oh, an error', 'Dead end, try another way', 'Nope, again', 'Failure is information too'],
        mFailWhy: ['It said: {r}', 'The tool told me: {r}', 'Hmm, {r} — trying another way', 'Aww… {r}'],
        muse: ['{n} sessions are keeping me company', 'You look good writing code', 'Take a break? Drink some water', 'I have been watching you'],
        answering: ['Pick one, I will send it', 'This one is yours: {q}', 'Which one? I will answer for you', 'The call is yours'],
        answered: ['Done, sent it', 'Got it, that one', 'Answered, back to work', 'There, I clicked it for you'],
      },
    }
    const DEFAULT_PREFS = { x: 26, y: 104, size: 160, hidden: false, rate: 'calm', talk: true }
    const MIN_SIZE = 80
    const MAX_SIZE = 320

    /** 没事干的时候可以过的几种「生活」。 */
    const ACTIVITIES = [
      { id: 'sleep', pool: 'sleep', scale: 1.4 },
      { id: 'eat', pool: 'eat', scale: 1 },
      { id: 'sing', pool: 'sing', scale: 1 },
      { id: 'slack', pool: 'slack', scale: 1 },
      { id: 'daze', pool: 'daze', scale: 0.9 },
      { id: 'mischief', pool: 'mischief', scale: 0.8 },
      { id: 'roam', pool: 'roam', scale: 0.7 },
    ]

    /** 节奏档位：一段生活持续多久、每个动作待多久（毫秒）。 */
    const RATE_PRESETS = {
      calm: { activityMin: 90000, activityMax: 180000, ambientDwell: 10000, busyDwell: 6000, pokeDwell: 2800, celebrateDwell: 2600 },
      normal: { activityMin: 60000, activityMax: 120000, ambientDwell: 7000, busyDwell: 4800, pokeDwell: 2400, celebrateDwell: 2200 },
      lively: { activityMin: 30000, activityMax: 70000, ambientDwell: 5000, busyDwell: 3600, pokeDwell: 2000, celebrateDwell: 1800 },
    }
    const RATE_ORDER = ['calm', 'normal', 'lively']

    /**
     * 拖动和放下各自只锁定一个动作，全程不切换：
     * 拎起来时抽一个（一直播到松手），放下时再抽一个，播满它自己那一轮自然循环
     * 才结束 —— 所以不会停在动作播一半的地方。太短的动画至少停留 DROP_MIN_MS。
     */
    const DROP_MIN_MS = 1400

    /** 被拎住 / 刚被放下的样子（纯表现层，注入一次样式表）。 */
    const PET_CSS = `
@keyframes dsh-fish-pet-drop {
  0% { transform: translateY(-2px) scale(1.08, 0.92); }
  35% { transform: translateY(-12px) scale(0.95, 1.06); }
  70% { transform: translateY(0) scale(1.04, 0.97); }
  100% { transform: translateY(0) scale(1); }
}
@keyframes dsh-fish-pet-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.3; transform: scale(0.8); }
}`

    /** 开工后先播多久「思考」再切到「干活」；0 就是整个任务只用一个动作。 */
    const THINK_LEAD_MS = 6000

    /**
     * 花名册：宠物 / 动画 / 池子。
     *
     * 默认是构建时写死的那份；组件挂载后会向 Host 要一份最新的（GET BASE/__roster），
     * 拿到就整体替换 —— 所以「往 assets/ 丢一只新宠物 → 面板里点重扫」或者
     * 「往 res/ 丢压缩包 → 面板里点导入」都能立刻用，不用重新构建客户端。
     * Host 半边不可用（没重启、老版本）时静默留在构建时的数据上，功能照旧。
     */
    const catalog = { pets: [], assets: [], pools: {}, source: 'built', generatedAt: null, warnings: [], res: null, scanMs: 0 }
    const BY_FILE = new Map()
    const ASSETS_BY_PET = new Map()
    const RESOLVED_POOLS = new Map()
    /** 素材全空时的占位动画：让渲染和状态机有个东西可以用，界面会改成提示卡片。 */
    const PLACEHOLDER = { f: '', u: '', n: '', ms: 2400, pet: '' }

    /** 用一份花名册整体替换当前数据（同时清掉按宠物缓存的池子）。 */
    function applyCatalog(next, source) {
      const data = next && typeof next === 'object' ? next : {}
      catalog.pets = Array.isArray(data.pets) ? data.pets.filter((pet) => pet && typeof pet.id === 'string') : []
      catalog.assets = Array.isArray(data.assets)
        ? data.assets.filter((asset) => asset && typeof asset.f === 'string' && typeof asset.u === 'string')
        : []
      catalog.pools = data.pools && typeof data.pools === 'object' ? data.pools : {}
      catalog.source = source
      catalog.generatedAt = typeof data.generatedAt === 'string' ? data.generatedAt : null
      catalog.warnings = Array.isArray(data.warnings) ? data.warnings : []
      catalog.res = data.res && typeof data.res === 'object' ? data.res : null
      catalog.scanMs = Number.isFinite(data.scanMs) ? data.scanMs : 0

      BY_FILE.clear()
      ASSETS_BY_PET.clear()
      RESOLVED_POOLS.clear()
      for (const asset of catalog.assets) {
        if (!BY_FILE.has(asset.f)) BY_FILE.set(asset.f, asset)
        if (!ASSETS_BY_PET.has(asset.pet)) ASSETS_BY_PET.set(asset.pet, [])
        ASSETS_BY_PET.get(asset.pet).push(asset)
      }
    }

    applyCatalog({ pets: BUILT_PETS, assets: BUILT_ASSETS, pools: BUILT_POOLS }, 'built')

    function petIds() {
      return catalog.pets.map((pet) => pet.id)
    }

    function defaultPet() {
      return catalog.pets.length > 0 ? catalog.pets[0].id : ''
    }

    function petAssets(petId) {
      return ASSETS_BY_PET.get(petId) || []
    }

    function petLabel(petId) {
      const pet = catalog.pets.find((entry) => entry.id === petId)
      return pet ? pet.label : petId
    }

    /** 某只宠物的某个池子 → 动画对象数组；池子没配或名字对不上就退回该宠物的全部素材。 */
    function pool(petId, key) {
      const cacheKey = `${petId}|${key}`
      if (RESOLVED_POOLS.has(cacheKey)) return RESOLVED_POOLS.get(cacheKey)
      const petPools = catalog.pools[petId] || {}
      const names = petPools[key]
      const list = Array.isArray(names) ? names.map((file) => BY_FILE.get(file)).filter(Boolean) : []
      const result = list.length > 0 ? list : petAssets(petId)
      RESOLVED_POOLS.set(cacheKey, result)
      return result
    }

    const DICT = {
      'zh-CN': {
        label: '蓝色大肥鱼桌宠',
        title: '蓝色大肥鱼桌宠',
        hint: '拖动移动 · 单击逗它 · 双击或右键打开面板',
        size: '大小',
        rate: '换动作',
        talk: '说话',
        talkOn: '开',
        talkOff: '关',
        sayOne: '说一句',
        calm: '安静',
        normal: '正常',
        lively: '活泼',
        poke: '逗一下',
        auto: '恢复自动',
        hide: '藏起来',
        show: '把鱼放出来',
        reset: '复位位置',
        search: '搜索动画…',
        noMatch: '没有匹配的动画',
        noAssets: '没有桌宠素材',
        loadFail: '桌宠素材加载失败',
        buildHint: '先跑 node tools/build-client.mjs',
        total: '个动画可选',
        playing: '正在播',
        state: 'DSH',
        working: '干活中',
        waiting: '等你回答',
        attention: '等你回答',
        running: '正在干活',
        done: '刚干完活',
        idle: '没事干',
        pet: '宠物',
        pets: '桌宠',
        petSwap: '换一只',
        sleep: '睡觉',
        eat: '干饭',
        sing: '唱歌蹦迪',
        slack: '摸鱼',
        daze: '发呆',
        mischief: '搞事',
        roam: '瞎逛',
        pin: '你选的',
        hold: '被拎着',
        drop: '刚被放下',
        pokeState: '卖萌',
        celebrate: '庆祝',
        diag: '诊断',
        srcSlot: '槽 props',
        srcService: '会话服务',
        srcNone: '都不可用',
        sessions: '会话',
        sRun: '干活',
        sWait: '等待',
        sDone: '未读',
        sTokens: 'token',
        sEvents: '事件',
        rescan: '重扫',
        rescanTitle: '重新扫描 assets/ 目录（丢进去的新宠物目录立刻出现）',
        import: '导入',
        importTitle: '把 res/ 里的压缩包解压成新宠物',
        importForce: '强制重解压',
        importForceTitle: '忽略时间戳，把 res/ 里的压缩包全部重新解压一遍',
        importing: '解压中…',
        importNone: 'res/ 里没有待导入的压缩包',
        importFail: '导入失败',
        roster: '花名册',
        rosterRuntime: '运行时',
        rosterBuilt: '构建时',
        rosterFail: '拉花名册失败（Host 半边可能要重启 dsh）',
        petHint: '换宠物：直接把桌宠压缩包丢进 res/ 点「导入」，或往 assets/ 放一个目录点「重扫」',
        noAssetsHint: '把桌宠压缩包（.7z / .zip）丢进 res/，然后点下面的「导入」',
        archive: '压缩包',
        answerTitle: '等你回答',
        answerCollapse: '收起',
        answerSubmit: '确定',
        answerCustom: '自己填',
        answerCustomTitle: '光标送进官方卡片的「自己填」输入框；不在这个会话就先切到那道题所在的会话',
      },
      en: {
        label: 'Blue Fish desktop pet',
        title: 'Blue Fish pet',
        hint: 'drag to move · click to poke · double-click or right-click for the panel',
        size: 'Size',
        rate: 'Pace',
        talk: 'Talk',
        talkOn: 'on',
        talkOff: 'off',
        sayOne: 'Say something',
        calm: 'Calm',
        normal: 'Normal',
        lively: 'Lively',
        poke: 'Poke',
        auto: 'Auto mode',
        hide: 'Hide',
        show: 'Bring the fish back',
        reset: 'Reset position',
        search: 'Search animations…',
        noMatch: 'no matching animation',
        noAssets: 'No pet assets',
        loadFail: 'Pet assets failed to load',
        buildHint: 'run node tools/build-client.mjs first',
        total: 'animations',
        playing: 'Now',
        state: 'DSH',
        working: 'working',
        waiting: 'waiting for you',
        attention: 'waiting for you',
        running: 'working',
        done: 'just finished',
        idle: 'idle',
        pet: 'Pet',
        pets: 'Pets',
        petSwap: 'Switch pet',
        sleep: 'sleeping',
        eat: 'eating',
        sing: 'singing',
        slack: 'slacking',
        daze: 'daydreaming',
        mischief: 'causing trouble',
        roam: 'wandering',
        pin: 'pinned',
        hold: 'held up',
        drop: 'just dropped',
        pokeState: 'being cute',
        celebrate: 'celebrating',
        diag: 'diag',
        srcSlot: 'slot props',
        srcService: 'session service',
        srcNone: 'unavailable',
        sessions: 'sessions',
        sRun: 'running',
        sWait: 'waiting',
        sDone: 'unread',
        sTokens: 'tokens',
        sEvents: 'events',
        rescan: 'Rescan',
        rescanTitle: 'Rescan the assets/ directory (a new pet folder shows up immediately)',
        import: 'Import',
        importTitle: 'Extract the archives in res/ as new pets',
        importForce: 'Force',
        importForceTitle: 'Ignore timestamps and re-extract every archive in res/',
        importing: 'Extracting…',
        importNone: 'nothing new to import in res/',
        importFail: 'import failed',
        roster: 'Roster',
        rosterRuntime: 'runtime',
        rosterBuilt: 'built-in',
        rosterFail: 'roster fetch failed (the host half may need a dsh restart)',
        petHint: 'Switch pets: drop a pack into res/ and hit Import, or drop a folder into assets/ and hit Rescan',
        noAssetsHint: 'Drop a pet pack (.7z / .zip) into res/ and hit Import below',
        archive: 'archives',
        answerTitle: 'Your call',
        answerCollapse: 'Hide',
        answerSubmit: 'Send',
        answerCustom: 'Type it',
        answerCustomTitle: "Put the caret in the official card's own answer field, switching to that conversation if needed",
      },
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    /** 把秒数说成人话：83 → 「1 分 23 秒」。 */
    function formatDuration(seconds) {
      const total = Math.max(1, Math.round(seconds))
      if (total < 60) return `${total} 秒`
      const minutes = Math.floor(total / 60)
      const rest = total % 60
      return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
    }

    /** 1234 → 「1.2k」。 */
    function formatTokens(count) {
      if (count < 1000) return String(Math.max(0, Math.round(count)))
      return `${(count / 1000).toFixed(1)}k`
    }

    /**
     * 会话列表里宿主算好的 token 投影：把每个会话的累计用量加起来。
     * 返回数字（选择器 hook 靠值比较决定要不要重渲染，数字最稳）。
     */
    function selectTokenTotal(state) {
      let total = 0
      if (state && state.byId) {
        for (const id of Object.keys(state.byId)) {
          const usage = state.byId[id] && state.byId[id].projectionValues && state.byId[id].projectionValues.tokenUsage
          if (usage) total += (usage.uncachedInputTokens || 0) + (usage.outputTokens || 0)
        }
      }
      return total
    }

    function selectTokenOutput(state) {
      let total = 0
      if (state && state.byId) {
        for (const id of Object.keys(state.byId)) {
          const usage = state.byId[id] && state.byId[id].projectionValues && state.byId[id].projectionValues.tokenUsage
          if (usage) total += usage.outputTokens || 0
        }
      }
      return total
    }

    /** 槽里没给 useSessions 时的退路。 */
    function useNoSessions() {
      return 0
    }

    /**
     * 该盯哪个会话：优先正在干活的那个，其次主视图里那个。
     * 返回会话 id 字符串（选择器 hook 靠值比较，字符串最稳）。
     */
    function selectWatchedSession(state) {
      if (!state || !state.byId) return ''
      const ids = Array.isArray(state.ids) && state.ids.length > 0 ? state.ids : Object.keys(state.byId)
      let running = ''
      let main = ''
      for (const id of ids) {
        const row = state.byId[id]
        if (!row) continue
        if (running === '' && row.running === true) running = id
        if (main === '' && row.retainedBy && row.retainedBy.mainView > 0) main = id
      }
      return running || main || ''
    }

    /** 干活播报的最小间隔：太密就像解说员了。 */
    const WORK_SAY_GAP_MS = 15000

    /** 颜文字：按情绪分组，说话时随机挂一个（不用逐句手写）。 */
    const KAOMOJI = {
      happy: ['(◕‿◕)', '(*≧▽≦)', '(๑•̀ㅂ•́)و✧', 'ヾ(≧▽≦*)o', '(๑˃̵ᴗ˂̵)', '(◍•ᴗ•◍)'],
      shy: ['(///▽///)', '(๑´ω`๑)', '(⁄ ⁄•⁄ω⁄•⁄)', '(〃∀〃)'],
      sad: ['(｡•́︿•̀｡)', '(っ˘̩╭╮˘̩)っ', '(｡╯︵╰｡)'],
      panic: ['(°ロ°)', 'Σ(°△°|||)', '(ﾟДﾟ;)', '(((ºДº;)'],
      sleepy: ['(¦3[▓▓]', '(っ˘ω˘ς)', '(－_－) zzZ'],
      think: ['(・∀・)', '(￣▽￣)', '(。・ω・。)', '(๑･ω･๑)'],
      work: ['(๑•̀ㅂ•́)و', '(ง •̀_•́)ง', '(๑•̀ㅁ•́๑)✧'],
      plead: ['(´･ω･`)', '(｡･ω･｡)ﾉ♡', '(๑•́ ₃ •̀๑)'],
      proud: ['(๑˃ᴗ˂)ﻭ', 'ᕦ(ò_óˇ)ᕤ', '(•̀ᴗ•́)و'],
    }

    /** 每个台词池对应哪种情绪。没列的池就不挂颜文字。 */
    const POOL_MOOD = {
      poke: 'shy',
      moe: 'shy',
      show: 'happy',
      celebrate: 'happy',
      pin: 'shy',
      hold: 'panic',
      drop: 'sad',
      mFail: 'sad',
      mFailWhy: 'sad',
      sleep: 'sleepy',
      eat: 'happy',
      sing: 'happy',
      slack: 'shy',
      daze: 'sleepy',
      mischief: 'happy',
      roam: 'think',
      think: 'think',
      mThink: 'think',
      mWeb: 'think',
      mLearn: 'think',
      muse: 'think',
      work: 'work',
      mWrite: 'work',
      mRead: 'work',
      mSearch: 'work',
      mEdit: 'work',
      mRun: 'work',
      mPlan: 'work',
      mPlugin: 'work',
      mTool: 'work',
      mDelegate: 'proud',
      mOk: 'proud',
      report: 'proud',
      reportTime: 'proud',
      mAsk: 'plead',
      attention: 'plead',
      answering: 'plead',
      answered: 'happy',
      done: 'happy',
      notify: 'happy',
    }

    /** 挂颜文字的概率；剩下的时候留白，免得每句都花里胡哨。 */
    const KAOMOJI_CHANCE = 0.75

    /** 情绪 → 气泡描边颜色（和颜文字同一个情绪，深色主题下也压得住）。 */
    const MOOD_TINT = {
      happy: '#ff8fb1',
      shy: '#ff9ec4',
      sad: '#8fb8ff',
      panic: '#ffb27a',
      sleepy: '#a99cff',
      think: '#84d2ff',
      work: '#8fdca0',
      plead: '#ffc46b',
      proud: '#ffd166',
    }

    /** 给台词挂一个对味的颜文字；句子本来就以括号结尾（或已有颜文字）就不叠。 */
    function decorate(text, poolKey) {
      const mood = POOL_MOOD[poolKey]
      const list = mood ? KAOMOJI[mood] : null
      if (!Array.isArray(list) || list.length === 0) return text
      if (Math.random() > KAOMOJI_CHANCE) return text
      if (/[)）]$/.test(text)) return text
      return `${text} ${list[Math.floor(Math.random() * list.length)]}`
    }

    /** 工具名 → 播报分类（池名后缀）。 */
    const TOOL_CATEGORY = {
      read: 'Read',
      read_image: 'Read',
      grep: 'Search',
      glob: 'Search',
      edit: 'Edit',
      write: 'Edit',
      present: 'Edit',
      todo_write: 'Plan',
      create_goal: 'Plan',
      get_goal: 'Plan',
      update_goal: 'Plan',
      bash: 'Run',
      pwsh: 'Run',
      job_list: 'Run',
      job_output: 'Run',
      job_kill: 'Run',
      web_search: 'Web',
      web_fetch: 'Web',
      skill: 'Learn',
      subagent: 'Delegate',
      subagent_fork: 'Delegate',
      workflow: 'Delegate',
      ask_user_question: 'Ask',
      cordis_define: 'Plugin',
      cordis_run: 'Plugin',
      cordis_stop: 'Plugin',
      cordis_undefine: 'Plugin',
      cordis_inspect_list: 'Plugin',
      cordis_inspect_query: 'Plugin',
    }

    /** 从工具参数里抠一个能说出口的细节（文件名、命令、搜索词…）。 */
    function toolDetail(argumentsJson) {
      let args = null
      try {
        args = JSON.parse(String(argumentsJson || '{}'))
      } catch {
        args = null
      }
      if (!args || typeof args !== 'object') return ''
      const text = (key) => (typeof args[key] === 'string' ? args[key] : '')
      const base = (value) => {
        const parts = String(value).split(/[\\/]/)
        return parts[parts.length - 1] || ''
      }
      const first = (value, words) => String(value).split(/\s+/).slice(0, words).join(' ').slice(0, 24)
      if (text('file_path') !== '') return base(text('file_path'))
      if (text('path') !== '') return base(text('path'))
      if (text('pattern') !== '') return text('pattern').slice(0, 28)
      if (text('command') !== '') return first(text('command'), 2)
      if (text('query') !== '') return text('query').slice(0, 24)
      if (text('url') !== '') return text('url').slice(0, 24)
      if (text('description') !== '') return text('description').slice(0, 24)
      return ''
    }

    /**
     * 把事件流最新的一条翻成「一个瞬间」：她在想 / 在写 / 叫了哪个工具 / 工具成了还是炸了。
     * 返回 { pool, vars } —— pool 是台词池名，vars 是替换进台词里的真实细节。
     * @param entry 事件窗口里的一条（durable 或 transient）
     * @param calls callId → { name, detail } 的记忆表（tool/result 本身不带工具名）
     */
    function momentOf(entry, calls) {
      if (!entry || typeof entry !== 'object') return null
      const event = entry.event
      if (!event || typeof event !== 'object') return null

      // 实时流：思考 / 写答案 / 准备调工具
      if (entry.type === 'transient') {
        const chunk = event.data && event.data.chunk
        if (!chunk || typeof chunk !== 'object') return null
        if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') {
          return { pool: 'mThink', vars: {} }
        }
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') {
          return { pool: 'mWrite', vars: {} }
        }
        return null
      }

      if (event.type === 'tool/call') {
        const data = event.data || {}
        const name = typeof data.name === 'string' ? data.name : 'tool'
        const detail = toolDetail(data.arguments)
        if (typeof data.callId === 'string') {
          calls.set(data.callId, { name, detail })
          // 长时间会话别把这张表攒爆：只留最近的记录。
          if (calls.size > 400) {
            const oldest = calls.keys().next().value
            if (oldest !== undefined) calls.delete(oldest)
          }
        }
        return { pool: `m${TOOL_CATEGORY[name] || 'Tool'}`, vars: { x: detail || name } }
      }

      if (event.type === 'tool/result') {
        const data = event.data || {}
        const block = data.message && Array.isArray(data.message.content) ? data.message.content[0] : null
        const callId = block && typeof block.toolCallId === 'string' ? block.toolCallId : ''
        const remembered = callId !== '' ? calls.get(callId) : undefined
        const failed = data.error !== undefined || (block && block.isError === true)
        const reason = data.error && typeof data.error.reason === 'string' ? data.error.reason.slice(0, 40) : ''
        return {
          // 有真实错误原因就直接报出来，比笼统的「报错了」有意思。
          pool: failed ? (reason === '' ? 'mFail' : 'mFailWhy') : 'mOk',
          vars: { x: (remembered && (remembered.detail || remembered.name)) || '', r: reason },
        }
      }

      if (event.type === 'assistant/message') {
        const data = event.data || {}
        if (data.interrupted === true) return { pool: 'mFail', vars: { x: '', r: '' } }
        return null
      }

      return null
    }

    /**
     * 桌宠是常驻的悬浮层，一旦渲染抛错会把整个 AppFrame 一起带走，
     * 所以自己兜住错误：坏掉的只是这条鱼，不是用户的界面。
     */
    class PetBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('dsh-fish-pet: render failed, desktop pet disabled for this session', error)
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    function loadPrefs() {
      const base = { ...DEFAULT_PREFS, pet: defaultPet() }
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return base
        const parsed = JSON.parse(raw)
        return {
          ...base,
          x: Number.isFinite(parsed.x) ? parsed.x : base.x,
          y: Number.isFinite(parsed.y) ? parsed.y : base.y,
          size: Number.isFinite(parsed.size) ? clamp(parsed.size, MIN_SIZE, MAX_SIZE) : base.size,
          hidden: parsed.hidden === true,
          rate: RATE_ORDER.includes(parsed.rate) ? parsed.rate : base.rate,
          talk: parsed.talk !== false,
          // 素材换过之后旧 id 可能不存在了，退回默认宠物（花名册到位后还会再校一次）。
          pet: petIds().includes(parsed.pet) ? parsed.pet : base.pet,
        }
      } catch {
        return base
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      } catch {
        /* 隐私模式下写不进去就算了，本次会话仍然可用 */
      }
    }

    function srcOf(asset) {
      // 用 build 阶段算好的 URL 片段（文件名）：Host 半边按文件名在整棵素材树里找，
      // 所以素材挪进子目录、换压缩包都不影响这里。
      return `${BASE}/${asset.u}`
    }

    function pick(list, avoid) {
      // 素材整个空的时候也要给渲染一个东西用（界面会换成提示卡片）。
      const poolList = list && list.length > 0 ? list : catalog.assets
      if (poolList.length === 0) return PLACEHOLDER
      if (poolList.length === 1) return poolList[0]
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = poolList[Math.floor(Math.random() * poolList.length)]
        if (!avoid || candidate.f !== avoid.f) return candidate
      }
      return poolList[0]
    }

    /**
     * 把整张会话状态表压成一个字符串：`阶段|会话数|干活|等待|未读`。
     * 返回字符串而不是对象，是因为选择器 hook 靠值比较决定要不要重渲染。
     */
    function worldSummaryOf(statuses) {
      let total = 0
      let running = 0
      let waiting = 0
      let finished = 0
      if (statuses && typeof statuses.forEach === 'function') {
        statuses.forEach((status) => {
          total += 1
          if (!status) return
          if (status.pendingInteraction) waiting += 1
          if (status.running === true) running += 1
          if (status.completionUnread === true) finished += 1
        })
      }
      const phase = waiting > 0 ? 'attention' : running > 0 ? 'running' : finished > 0 ? 'done' : 'idle'
      return `${phase}|${total}|${running}|${waiting}|${finished}`
    }

    function parseWorldSummary(summary) {
      const parts = typeof summary === 'string' ? summary.split('|') : []
      return {
        phase: parts[0] || 'idle',
        total: Number(parts[1] ?? 0),
        running: Number(parts[2] ?? 0),
        waiting: Number(parts[3] ?? 0),
        finished: Number(parts[4] ?? 0),
      }
    }

    /** 槽里没给 useSessionStatus 时的退路：世界永远「没事干」，宠物照样活着。 */
    function useNoWorldSummary() {
      return 'idle|0|0|0|0'
    }

    /** 槽的标准 props 路线（正规做法：shell.overlay 会传 useSessionStatus）。 */
    function useSlotWorldSummary(hook) {
      const useHook = typeof hook === 'function' ? hook : useNoWorldSummary
      return useHook(worldSummaryOf)
    }

    /**
     * 服务路线：直接订阅 ctx.uiSession.sessionStatus。
     * 万一槽没给 hook（或者注册组件忘了转发 props）时兜底。
     */
    function useServiceWorldSummary(store) {
      const read = React.useCallback(() => (store ? store.read() : 'idle|0|0|0|0'), [store])
      const [summary, setSummary] = React.useState(read)
      React.useEffect(() => {
        if (!store) return undefined
        setSummary(store.read())
        return store.subscribe(() => setSummary(store.read()))
      }, [store, read])
      return summary
    }

    /** 素材缺失/加载失败时的提示条样式。 */
    const NOTICE_STYLE = {
      position: 'fixed',
      right: 14,
      bottom: 104,
      zIndex: 62,
      maxWidth: 260,
      pointerEvents: 'auto',
      padding: '6px 10px',
      borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      background: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.97))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 11,
      lineHeight: 1.5,
      boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
    }

    /**
     * 待回答问题（方案 B：与官方卡片赛跑）。
     *
     * Host 把 ask_user_question 的请求发到客户端瀑布上（remote 事件
     * user-questions/request），谁先给出答案谁赢。官方卡片也在这条瀑布上，
     * 所以宠物这边**不顶替**它：先 next() 让官方照常挂上自己的等待和登记，
     * 再把自己的一张答题卡挂到桥上报给组件 —— 用户点宠物这边的选项就立刻
     * 返回答案，点官方那边就让官方先返回。
     *
     * 桥是模块级的单槽（只有一条鱼、一次只接一题）：apply() 里的 handler 写，
     * FishPet 读，两边生命周期互不相干。
     */
    const QUESTIONS = {
      /** 当前挂着的一题；null = 没有。 */
      state: null,
      listeners: new Set(),
      /** 宠物被藏起来的时候：不渲染答题卡，也不参与竞争。 */
      hidden: false,
      publish(next) {
        this.state = next
        for (const listener of [...this.listeners]) {
          try {
            listener(next)
          } catch (error) {
            console.error('dsh-fish-pet: question listener failed', error)
          }
        }
      },
      /** 只有还挂着这一题时才清掉（别把后来者误清）。 */
      publishIf(slot, next) {
        if (this.state === slot) this.publish(next)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
      /** 宠物被藏起来 / 组件卸载：只收宠物这张卡，官方那一题照旧挂着等用户。 */
      dismissActive() {
        const slot = this.state
        if (slot !== null && slot.settled !== true) slot.dismiss()
      },
    }

    /**
     * 这题宠物接不接？只接「一题、有选项、不是 plan-review」的通用选择题；
     * 多题、计划审批、没有选项的自由问答、宠物被藏起来 —— 全部原样交给官方卡片。
     */
    function petCanAnswer(request) {
      if (QUESTIONS.hidden) return false
      const questions = request && Array.isArray(request.questions) ? request.questions : []
      if (questions.length !== 1) return false
      const question = questions[0]
      if (!question || typeof question.id !== 'string') return false
      if (question.intent && question.intent.kind === 'plan-review') return false
      const options = Array.isArray(question.options) ? question.options : []
      return options.some((option) => option && typeof option.label === 'string' && option.label !== '')
    }

    /**
     * 这条 request 属于哪个会话。认不出（sessions 还没起来 / 不是 agent 会话）就返回 undefined：
     * 和官方一样，认不出会话就不碰，免得把题挂到错误的会话上。
     */
    function sessionOf(ctx, owner) {
      const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (!sessions || typeof sessions.scopeOf !== 'function') return undefined
      try {
        const id = sessions.scopeOf(owner)
        return typeof id === 'string' && id !== '' ? id : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 这个会话当前挂着的官方待回答互动（官方卡片背后那个 PendingQuestion）。
     *
     * uiSession 的 sessionStatus 是公开的 getSnapshot/subscribe 对，而
     * registerPendingInteraction 是**同步**写进快照的 —— 所以调完 next() 立刻就能读到。
     * 读不到（uiSession 没起来 / 官方没建互动）就返回 null：那就不渲染、不参与。
     */
    function pendingQuestionOf(uiSession, sessionId) {
      if (!uiSession || !uiSession.sessionStatus) return null
      if (typeof uiSession.sessionStatus.getSnapshot !== 'function') return null
      let snapshot = null
      try {
        snapshot = uiSession.sessionStatus.getSnapshot()
      } catch {
        return null
      }
      if (!snapshot || typeof snapshot.get !== 'function') return null
      const row = snapshot.get(sessionId)
      const pending = row && row.pendingInteraction
      return pending && typeof pending.answer === 'function' ? pending : null
    }

    /** 确认这个待回答互动就是我们这条题（先比引用，引用没保住就比 id + 题数）。 */
    function looksLikeOurQuestion(pending, questions) {
      if (!pending || !Array.isArray(pending.questions)) return false
      if (pending.questions === questions) return true
      if (pending.questions.length !== questions.length) return false
      return questions.every(
        (question, index) => pending.questions[index] && pending.questions[index].id === question.id,
      )
    }

    /**
     * 「自己填」：把光标直接送进官方卡片那个自定义输入框。
     *
     * 官方卡片的根节点带 `data-question-key="<pending.key>"`，它的「自己填」就是
     * 卡片里唯一的 textarea —— 所以按 we 手上这条 pending 的 key 定位过去就行，
     * 比把光标丢到会话主输入框更准（后者会让人以为要发聊天消息）。
     * 够不着（卡片被最小化 / 会话没开着 / 没有 DOM）就退回聚焦会话输入框。
     */
    /** 按 pending.key 找到官方卡片里的自定义 textarea 并聚焦；找不到（没渲染 / 被最小化）返回 false。 */
    function focusOfficialField(pending) {
      try {
        const key = pending && typeof pending.key === 'string' ? pending.key : ''
        if (typeof document === 'undefined' || key === '') return false
        // key 是官方生成的 `question:<n>`；转义掉选择器里有特殊含义的字符，别让整段炸掉。
        const card = document.querySelector(`[data-question-key="${key.replace(/["\\]/g, '\\$&')}"]`)
        const field = card && typeof card.querySelector === 'function' ? card.querySelector('textarea') : null
        if (!field || typeof field.focus !== 'function') return false
        if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'nearest' })
        field.focus()
        return true
      } catch {
        return false
      }
    }

    /** 请 uiWorkspace 把这道题所在的会话切到前台（和侧边栏点会话是同一个入口）。 */
    function openSessionFor(ctx, sessionId) {
      try {
        if (sessionId === undefined) return false
        const workspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        if (!workspace || typeof workspace.openSession !== 'function') return false
        workspace.openSession(sessionId)
        return true
      } catch (error) {
        console.error('dsh-fish-pet: open session failed', error)
        return false
      }
    }

    /**
     * 「自己填」：把用户送到官方卡片那个自定义输入框。
     *
     * 1. 官方卡片就在眼前（正在看这个会话）→ 直接把光标放进去；
     * 2. 你在**别的**会话里看这道题（官方卡片根本没渲染，那个 textarea 不在 DOM 里）→
     *    先请 uiWorkspace 把拥有这道题的会话切到前台，等卡片挂载出来再补聚焦
     *    （切完 React 才渲染，所以要重试几次）；
     * 3. 实在送不到（没 uiWorkspace / 卡片被最小化）→ 退而求其次聚焦会话输入框。
     *
     * 只有**真把光标送到了**才回调 onFocused（用来收起宠物卡）——
     * 什么都没送到就把卡留着，免得人一脸问号。
     */
    function focusCustomAnswer(ctx, owner, pending, sessionId, onFocused) {
      if (focusOfficialField(pending)) {
        onFocused()
        return
      }
      if (!openSessionFor(ctx, sessionId)) {
        if (focusConversation(ctx, owner)) onFocused()
        return
      }
      let attempts = 0
      const retry = () => {
        if (focusOfficialField(pending)) {
          onFocused()
          return
        }
        attempts += 1
        if (attempts <= 20) {
          window.setTimeout(retry, 50)
          return
        }
        if (focusConversation(ctx, owner)) onFocused()
      }
      retry()
    }

    /**
     * 兜底：把键盘焦点送回会话输入框。
     * 会话没开在面板上时 input.for() 会拒绝未保留的 scope —— 点一下没反应就算了。
     */
    function focusConversation(ctx, owner) {
      try {
        const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
        const input = conversation && conversation.input
        if (!input || typeof input.for !== 'function') return false
        const shell = input.for(owner)
        if (!shell || typeof shell.focus !== 'function') return false
        shell.focus()
        return true
      } catch {
        /* 会话没打开 / 没有输入框：静默 */
        return false
      }
    }

    /**
     * 接住一条 user-questions/request。
     *
     * 这里**不跟官方卡片赛跑**：官方卡片收到同一条瀑布请求时会建一个 PendingQuestion
     * 并登记成这个 session 的 pendingInteraction。我们拿到那个把手，把同一题渲染到宠物这边：
     *   · 用户点宠物的选项 → 调官方 PendingQuestion.answer() → 官方卡片自己撤
     *     （它自己的 finally 会 remove），答案也由官方那条路回给 Host，载荷只有一个来源；
     *   · 用户点官方那边 → 我们监听 pending.result，宠物这张卡也一起消失。
     * 拿不到那个把手（没装官方卡片 / 我们排在它后面 / uiSession 还没起来）就不渲染、
     * 不参与竞争，把 next() 的结果原样透传回去。
     *
     * @param ctx 客户端 context（现取 sessions / uiSession / conversation）
     * @param owner 瀑布里的 this（agent scope）
     * @param request { questions, ... }
     * @param next 交给下一个应答者（官方卡片）
     * @returns 官方那条路的结果，原样透传
     */
    function answerWithPet(ctx, owner, request, next) {
      const uiSession = ctx && typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined
      const sessionId = sessionOf(ctx, owner)
      // 调 next() 之前先记下这个会话原有的互动：调完之后「多出来的那个」才是我们这条题。
      const before = sessionId === undefined ? null : pendingQuestionOf(uiSession, sessionId)

      // 第一步永远是让官方那条路照常走：官方卡片、它的 pendingInteraction 登记都发生在这一步。
      const downstream = typeof next === 'function' ? next() : null
      if (downstream !== null && typeof downstream.catch === 'function') downstream.catch(() => {})
      const official =
        downstream === null
          ? Promise.reject(new Error('dsh-fish-pet: user-questions/request arrived without next()'))
          : Promise.resolve(downstream)

      // 不接的题（多题 / plan-review / 没选项 / 宠物藏着 / 已经挂着一题 / 认不出会话）交回官方。
      if (!petCanAnswer(request)) return official
      if (QUESTIONS.state !== null && QUESTIONS.state.settled !== true) return official
      if (sessionId === undefined) return official

      const pending = pendingQuestionOf(uiSession, sessionId)
      if (pending === null || pending === before) return official
      if (!looksLikeOurQuestion(pending, request.questions)) return official

      const question = request.questions[0]
      const slot = {
        key: `${sessionId}#${question.id}`,
        sessionId,
        question,
        multi: question.multiSelect === true,
        pending,
        settled: false,
        /** 点选项 = 替官方提交答案：官方卡片会自己撤，答案也由官方那条路回给 Host。 */
        answer(selected) {
          if (this.settled) return
          this.settled = true
          QUESTIONS.publishIf(this, null)
          const payload = {
            answers: [{ id: question.id, selected: Array.isArray(selected) ? selected : [String(selected)] }],
          }
          try {
            // 已经结束的题再答一次会 reject（finish() 抛），挂上 catch 免得变成未处理拒绝。
            const result = this.pending.answer(payload)
            if (result && typeof result.catch === 'function') {
              result.catch((error) => console.error('dsh-fish-pet: pending question answer failed', error))
            }
          } catch (error) {
            console.error('dsh-fish-pet: pending question answer failed', error)
          }
        },
        /** 「收起」/「自己填」：只收宠物这张卡；官方那一题继续挂着等用户。 */
        dismiss() {
          if (this.settled) return
          this.settled = true
          QUESTIONS.publishIf(this, null)
        },
        /** 「自己填」：光标送进官方卡片的自定义输入框（必要时先把这道题所在会话切到前台）。 */
        focusCustom() {
          focusCustomAnswer(ctx, owner, pending, sessionId, () => this.dismiss())
        },
      }

      QUESTIONS.publish(slot)
      // 官方那边先结束（用户点了官方卡片 / 请求被撤销）：宠物这张卡也撤掉。
      const clear = () => {
        slot.settled = true
        QUESTIONS.publishIf(slot, null)
      }
      const settled = pending.result
      if (settled && typeof settled.then === 'function') settled.then(clear, clear)

      return official
    }

    function FishPet(props) {
      const t = props.t
      // t 放进 ref：花名册刷新那几个 useCallback 要保持稳定，
      // 不能因为每次渲染的 t 换了身份就重建（否则挂载时的刷新 effect 会自己转起来）。
      const tRef = React.useRef(t)
      tRef.current = t
      // 诊断用的词典状态（服务没了/没绑上时，面板的 i 行会显出来）。
      const localeInfo = typeof props.localeInfo === 'function' ? props.localeInfo : () => 'n/a'

      const timer = props.timer
      // 两条路都订阅（hook 顺序固定），优先用槽给的标准 props。
      const slotSummary = useSlotWorldSummary(props.useSessionStatus)
      const serviceSummary = useServiceWorldSummary(props.statusStore)
      const summary = typeof props.useSessionStatus === 'function' ? slotSummary : serviceSummary
      const world = parseWorldSummary(summary)
      const worldPhase = world.phase
      const sourceKey =
        typeof props.useSessionStatus === 'function' ? 'srcSlot' : props.statusStore ? 'srcService' : 'srcNone'
      // 本次干活的 token：宿主投影是「会话累计」，所以收工时算差值。
      const useSessionsSafe = typeof props.useSessions === 'function' ? props.useSessions : useNoSessions
      const tokenTotal = useSessionsSafe(selectTokenTotal)
      const tokenOutput = useSessionsSafe(selectTokenOutput)
      const watchedSessionId = useSessionsSafe(selectWatchedSession)

      const [prefs, setPrefs] = React.useState(loadPrefs)
      const [asset, setAsset] = React.useState(() => pick(pool(prefs.pet, 'daze')))
      const [token, setToken] = React.useState(0)
      const [pinned, setPinned] = React.useState(null)
      const [signal, setSignal] = React.useState(0)
      const [activity, setActivity] = React.useState(null)
      const [machineState, setMachineState] = React.useState('idle')
      const [panelOpen, setPanelOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [dragging, setDragging] = React.useState(false)
      const [showDiag, setShowDiag] = React.useState(false)
      const [bubble, setBubble] = React.useState(null)
      // 图片连续加载失败（素材被删了、assetDir 指错了）也要说出来，而不是默默显示裂图。
      const [imageFailures, setImageFailures] = React.useState(0)
      const [noticeHidden, setNoticeHidden] = React.useState(false)
      // 花名册：source 决定「运行时」还是「构建时」，导入/重扫的结果用 note 说一句。
      const [rosterSeq, setRosterSeq] = React.useState(0)
      const [rosterState, setRosterState] = React.useState('idle')
      const [importing, setImporting] = React.useState(false)
      const [rosterNote, setRosterNote] = React.useState(null)
      // 待回答问题：桥上的当前一题（apply() 里的 remote handler 写进来）。
      const [questionSeq, setQuestionSeq] = React.useState(0)
      // 多选时勾中的选项。
      const [picked, setPicked] = React.useState([])
      void questionSeq
      // handler 在 request 到达那一刻读这个标记：藏起来就整题交给官方。
      QUESTIONS.hidden = prefs.hidden
      const pendingQuestion = QUESTIONS.state
      const questionKey = pendingQuestion === null ? '' : pendingQuestion.key
      const pickedKeyRef = React.useRef('')
      if (pickedKeyRef.current !== questionKey) {
        // 换题（或题目结束）就清空多选，别把上一题的勾带到下一题。
        pickedKeyRef.current = questionKey
        if (picked.length !== 0) setPicked([])
      }

      const prefsRef = React.useRef(prefs)
      const assetRef = React.useRef(asset)
      const pinnedRef = React.useRef(pinned)
      const phaseRef = React.useRef(worldPhase)
      const draggingRef = React.useRef(dragging)
      const machineRef = React.useRef({
        pokeUntil: 0,
        celebrateUntil: 0,
        dropUntil: 0,
        holdAsset: null,
        dropAsset: null,
        runningSince: Date.now(),
        runAsset: null,
        runPhase: null,
        usageAtStart: null,
        doneSince: 0,
        activity: null,
        activityUntil: 0,
        activitySay: null,
      })
      const previousPhaseRef = React.useRef(worldPhase)
      const worldRef = React.useRef(world)
      const tokenRef = React.useRef({ total: tokenTotal, output: tokenOutput })
      const reportTimerRef = React.useRef(null)
      const sayRef = React.useRef(null)
      const lastSpokeAtRef = React.useRef(0)
      const lastLineRef = React.useRef({})
      const bubbleSeqRef = React.useRef(0)
      prefsRef.current = prefs
      assetRef.current = asset
      pinnedRef.current = pinned
      phaseRef.current = worldPhase
      draggingRef.current = dragging
      worldRef.current = world
      tokenRef.current = { total: tokenTotal, output: tokenOutput }

      const update = React.useCallback((patch) => {
        setPrefs((current) => {
          const next = { ...current, ...patch }
          savePrefs(next)
          return next
        })
      }, [])

      /** 当前语言的台词表（说话时现读，切换语言立刻生效）。 */
      const phraseTable = React.useCallback(() => {
        const active = typeof props.activeLocale === 'function' ? props.activeLocale() : 'zh'
        return /^zh/i.test(String(active)) ? PHRASES.zh : PHRASES.en
      }, [props.activeLocale])

      /** 定时一次，优先用 cordis timer（跟着插件 fiber 自动清理）。 */
      const scheduleOnce = React.useCallback(
        (fn, ms) => {
          if (timer && typeof timer.timeout === 'function') return timer.timeout(fn, ms)
          const id = window.setTimeout(fn, ms)
          return () => window.clearTimeout(id)
        },
        [timer],
      )

      /**
       * 说一句话。force 用于用户交互（点它、拖它、放下它、点列表），
       * 不受冷却限制；状态机自己触发的台词有 9 秒冷却，免得一直叨叨。
       */
      const speak = React.useCallback(
        (poolKey, options) => {
          const opts = options || {}
          if (prefsRef.current.talk === false) return
          // reveal：刚好在「放出来」的那一刻说话，此时 hidden 还是 true，得放行。
          if (prefsRef.current.hidden && opts.reveal !== true) return
          const table = phraseTable() || PHRASES.zh
          const lines = table[poolKey] || PHRASES.zh[poolKey]
          if (!Array.isArray(lines) || lines.length === 0) return
          const now = Date.now()
          if (opts.force !== true && now - lastSpokeAtRef.current < 9000) return
          let index = Math.floor(Math.random() * lines.length)
          if (lines.length > 1 && index === lastLineRef.current[poolKey]) index = (index + 1) % lines.length
          lastLineRef.current[poolKey] = index
          const vars = Object.assign({ n: opts.n === undefined ? '' : opts.n }, opts.vars || {})
          let text = String(lines[index])
          for (const key of Object.keys(vars)) text = text.split(`{${key}}`).join(String(vars[key]))
          text = decorate(text, poolKey)
          lastSpokeAtRef.current = now
          bubbleSeqRef.current += 1
          setBubble({
            id: bubbleSeqRef.current,
            text,
            mood: POOL_MOOD[poolKey] || null,
            until: now + clamp(2000 + text.length * 110, 2600, 9000),
          })
        },
        [phraseTable],
      )

      // 待回答问题：桥上换了题就重渲染（真实 React 靠订阅，命令行冒烟测试靠重画）。
      React.useEffect(() => {
        const off = QUESTIONS.subscribe(() => setQuestionSeq((n) => n + 1))
        return () => {
          off()
          // 组件没了（插件停用/整页卸载）：只收宠物这张卡，官方那一题照旧。
          QUESTIONS.dismissActive()
        }
      }, [])

      // 题目刚挂上来时说一句「选一个嘛」。
      const announcedQuestionRef = React.useRef('')
      React.useEffect(() => {
        if (questionKey === '') {
          // 题答完/收起之后把标记清掉：同一题再来一次还要说话。
          announcedQuestionRef.current = ''
          return
        }
        if (announcedQuestionRef.current === questionKey) return
        announcedQuestionRef.current = questionKey
        const slot = QUESTIONS.state
        if (slot === null) return
        speak('answering', { force: true, vars: { q: String(slot.question.question).slice(0, 16) } })
      }, [questionKey, speak])

      /** 提交宠物这边的答案：转交给官方那道待回答互动，官方卡片会自己撤。 */
      const answerQuestion = (slot, selected) => {
        if (slot === null || slot.settled) return
        setPicked([])
        slot.answer(selected)
        speak('answered', { force: true })
      }

      // 说明说完就收起来；台词越长挂得越久。
      React.useEffect(() => {
        if (bubble === null) return undefined
        const hold = Math.max(1200, bubble.until - Date.now())
        return scheduleOnce(() => setBubble(null), hold)
      }, [bubble, scheduleOnce])

      // ── 花名册：运行时从 Host 拉一份最新的宠物/动画/池子 ────────────────────
      /** 清掉状态机里的临时状态（换宠物 / 花名册变了之后不能让旧池子的动作留着）。 */
      const resetMachine = React.useCallback(() => {
        const machine = machineRef.current
        machine.pokeUntil = 0
        machine.celebrateUntil = 0
        machine.dropUntil = 0
        machine.holdAsset = null
        machine.dropAsset = null
        machine.runAsset = null
        machine.runPhase = null
        machine.activity = null
        machine.activityUntil = 0
        machine.activitySay = null
        setPinned(null)
      }, [])

      /**
       * 换一只宠物：纯前端切换，立刻换图（不等状态机下一个节拍），用新宠物的池子继续过日子。
       */
      const switchPet = React.useCallback(
        (petId) => {
          if (petId === prefsRef.current.pet) return
          if (!petIds().includes(petId)) return
          resetMachine()
          update({ pet: petId })
          const next = pick(pool(petId, 'daze'))
          if (next.f !== assetRef.current.f) setToken((n) => n + 1)
          assetRef.current = next
          setAsset(next)
          setSignal((n) => n + 1)
          speak('switchPet', { force: true, vars: { x: petLabel(petId) } })
        },
        [resetMachine, speak, update],
      )

      /**
       * 拉一次花名册。拿到就整体替换掉构建时写死的数据；失败就静默留在原数据上
       * （Host 半边没重启时就是这种情况，不该弹一堆错）。
       */
      const refreshRoster = React.useCallback(async (options) => {
        const opts = options || {}
        setRosterState('loading')
        try {
          const response = await fetch(`${BASE}/__roster${opts.force === true ? '?refresh=1' : ''}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          applyCatalog(data, 'runtime')
          setRosterState('ok')
          setRosterSeq((n) => n + 1)
          setRosterNote(null)
          return data
        } catch (error) {
          setRosterState('error')
          if (opts.loud === true) {
            setRosterNote(`${tRef.current('rosterFail')}（${error && error.message ? error.message : String(error)}）`)
          }
          return null
        }
      }, [])

      /** 把 res/ 里的压缩包解压成新宠物（面板上的「导入」）。 */
      const importFromRes = React.useCallback(
        async (force) => {
          setImporting(true)
          setRosterNote(null)
          try {
            const response = await fetch(`${BASE}/__import`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json', 'x-fish-pet': 'import' },
              body: JSON.stringify({ force: force === true }),
            })
            const data = await response.json().catch(() => null)
            if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
            if (data && Array.isArray(data.pets)) {
              applyCatalog(data, 'runtime')
              setRosterState('ok')
              setRosterSeq((n) => n + 1)
            }
            const imported = data && Array.isArray(data.imported) ? data.imported : []
            const failures = data && Array.isArray(data.failures) ? data.failures : []
            if (imported.length > 0) {
              const names = imported.map((id) => petLabel(id)).join('、')
              speak('imported', { force: true, vars: { x: names } })
              setRosterNote(`${tRef.current('import')}：${names}`)
              // 只导入了一只就顺手切过去，省掉一次点击。
              if (imported.length === 1) switchPet(imported[0])
            } else if (failures.length > 0) {
              setRosterNote(`${tRef.current('importFail')}：${failures[0].archive} — ${failures[0].reason}`)
            } else {
              setRosterNote(tRef.current('importNone'))
            }
            return data
          } catch (error) {
            setRosterNote(`${tRef.current('importFail')}：${error && error.message ? error.message : String(error)}`)
            return null
          } finally {
            setImporting(false)
          }
        },
        [speak, switchPet],
      )

      // 挂载后拉一次花名册（Host 半边是权威数据源，构建时那份只是兜底）。
      React.useEffect(() => {
        void refreshRoster({})
      }, [refreshRoster])

      // 花名册换了之后，选中的宠物可能已经不在里面（素材被删/换包）→ 退回第一只。
      React.useEffect(() => {
        const ids = petIds()
        if (ids.length === 0) return
        if (ids.includes(prefsRef.current.pet)) return
        resetMachine()
        const next = pick(pool(ids[0], 'daze'))
        if (next.f !== assetRef.current.f) setToken((n) => n + 1)
        assetRef.current = next
        setAsset(next)
        update({ pet: ids[0] })
        setSignal((n) => n + 1)
      }, [rosterSeq, resetMachine, update])

      // ── 干活播报：订阅当前会话的事件流，看她在想什么、调了什么工具、成没成 ──
      const binding = React.useMemo(() => {
        const service = props.sessionsService
        if (!service || watchedSessionId === '' || typeof service.binding !== 'function') return null
        try {
          return service.binding(watchedSessionId) || null
        } catch {
          return null
        }
      }, [props.sessionsService, watchedSessionId])

      const callsRef = React.useRef(new Map())
      const lastWorkSayRef = React.useRef(0)
      const lastMomentRef = React.useRef('')
      const eventCountRef = React.useRef(-1)

      const announce = React.useCallback(
        (moment) => {
          const now = Date.now()
          if (now - lastWorkSayRef.current < WORK_SAY_GAP_MS) return
          if (Math.random() < 0.3) return // 不是每个瞬间都播报，不然像解说员
          lastWorkSayRef.current = now
          speak(moment.pool, { force: true, vars: moment.vars })
        },
        [speak],
      )

      React.useEffect(() => {
        const source = binding && binding.eventSource
        if (!source || typeof source.subscribe !== 'function') return undefined
        const onPublish = () => {
          if (phaseRef.current !== 'running') return
          const snapshot = source.getSnapshot()
          const entries = snapshot && snapshot.entries
          if (!Array.isArray(entries)) return
          eventCountRef.current = entries.length
          if (entries.length === 0) return
          const key = String(snapshot.revision)
          if (key === lastMomentRef.current) return
          lastMomentRef.current = key
          const moment = momentOf(entries[entries.length - 1], callsRef.current)
          if (moment) announce(moment)
        }
        onPublish()
        return source.subscribe(onPublish)
      }, [binding, announce])

      // 干活时常驻的状态条要显示「干了多久」，所以干活期间每秒重渲染一次。
      const [beat, setBeat] = React.useState(0)
      React.useEffect(() => {
        if (worldPhase !== 'running') return undefined
        const bump = () => setBeat((n) => n + 1)
        if (timer && typeof timer.interval === 'function') return timer.interval(bump, 1000)
        const id = window.setInterval(bump, 1000)
        return () => window.clearInterval(id)
      }, [worldPhase, timer])

      const poke = React.useCallback(() => {
        machineRef.current.pokeUntil = Date.now() + 4200
        setSignal((n) => n + 1)
        speak('poke', { force: true })
      }, [speak])

      /** 下一步该播什么、多久之后再算下一步。 */
      const plan = React.useCallback(() => {
        const now = Date.now()
        const machine = machineRef.current
        const preset = RATE_PRESETS[prefsRef.current.rate] ?? RATE_PRESETS.calm
        // 当前这只宠物：池子是按宠物分的，所以每个 pool() 都要带上它。
        const pet = prefsRef.current.pet

        // 点它永远优先：即使固定了某个动画、或刚被放下，也要有可见反应，
        // 反应完再回到本该播的那个（否则「点它没反应」会变成 bug）。
        if (now < machine.pokeUntil) {
          return { asset: pick(pool(pet, 'moe'), assetRef.current), delay: preset.pokeDwell, activity: null, state: 'poke' }
        }
        if (pinnedRef.current !== null) {
          const fixed = BY_FILE.get(pinnedRef.current)
          if (fixed) return { asset: fixed, delay: 60000, activity: null, state: 'pin' }
        }
        if (draggingRef.current) {
          // 被拎着：全程只播抽中的那一个，拖着的时候不换动作。
          const held = machine.holdAsset || pick(pool(pet, 'hold'), assetRef.current)
          return { asset: held, delay: 3000, activity: null, state: 'hold' }
        }
        if (now < machine.dropUntil && machine.dropAsset) {
          // 刚被放下：同样只播抽中的那一个，播完这段就回去过日子。
          return {
            asset: machine.dropAsset,
            delay: Math.max(250, machine.dropUntil - now),
            activity: null,
            state: 'drop',
          }
        }
        if (now < machine.celebrateUntil) {
          return {
            asset: pick(pool(pet, 'celebrate'), assetRef.current),
            delay: preset.celebrateDwell,
            activity: null,
            state: 'celebrate',
          }
        }

        const phase = phaseRef.current
        if (phase === 'attention') {
          return {
            asset: pick(pool(pet, 'attention'), assetRef.current),
            delay: preset.busyDwell + 1500,
            activity: null,
            state: 'attention',
            say: 'attention',
          }
        }
        if (phase === 'running') {
          // 干活期间锁定一个动作：开工先「思考」，THINK_LEAD_MS 之后只切一次到「干活」，
          // 然后整个任务都用同一个动作，不再换。
          if (machine.runAsset === null) {
            machine.runAsset = pick(pool(pet, 'think'), assetRef.current)
            machine.runPhase = 'think'
          }
          const elapsed = now - machine.runningSince
          if (machine.runPhase === 'think' && elapsed >= THINK_LEAD_MS) {
            machine.runAsset = pick(pool(pet, 'work'), machine.runAsset)
            machine.runPhase = 'work'
          }
          return {
            asset: machine.runAsset,
            delay: machine.runPhase === 'think' ? Math.max(400, THINK_LEAD_MS - elapsed) : 60000,
            activity: null,
            state: 'running',
            say: machine.runPhase,
          }
        }
        if (phase === 'done' && now - machine.doneSince < 25000) {
          // 后台干完活先提醒一阵子，然后就回去过日子，不能一直举着铃铛。
          return {
            asset: pick(pool(pet, 'notify'), assetRef.current),
            delay: preset.busyDwell + 2000,
            activity: null,
            state: 'done',
            say: 'done',
          }
        }

        // 没事干：过一段「生活」，而不是一首一首换歌。
        if (machine.activity === null || now >= machine.activityUntil) {
          const candidates = ACTIVITIES.filter(
            (entry) => entry.pool !== machine.activity && pool(pet, entry.pool).length > 0,
          )
          const chosen = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : ACTIVITIES[0]
          const span = preset.activityMin + Math.random() * Math.max(0, preset.activityMax - preset.activityMin)
          machine.activity = chosen.pool
          machine.activityUntil = now + span * chosen.scale
          // 换生活的时候有 1/4 概率不说这件事，而是自言自语一句。
          machine.activitySay = Math.random() < 0.25 ? 'muse' : chosen.pool
        }
        return {
          asset: pick(pool(pet, machine.activity), assetRef.current),
          delay: preset.ambientDwell,
          activity: machine.activity,
          state: 'idle',
          say: machine.activitySay || machine.activity,
        }
      }, [])

      // 干活结束的那一下：庆祝几秒（等你回答不算「结束」）。
      React.useEffect(() => {
        const previous = previousPhaseRef.current
        previousPhaseRef.current = worldPhase
        if (worldPhase === 'running') {
          if (previous !== 'running') {
            machineRef.current.runningSince = Date.now()
            // 新的任务 = 新的动作抽签（整段任务只用一个）+ 记下开工时的累计用量。
            machineRef.current.runAsset = null
            machineRef.current.runPhase = null
            machineRef.current.usageAtStart = { ...tokenRef.current }
          }
          return
        }
        if (previous === 'running') {
          // 收工：把干活动作清掉，下次开工重新抽。
          machineRef.current.runAsset = null
          machineRef.current.runPhase = null
        }
        if (worldPhase === 'done' && previous !== 'done') {
          machineRef.current.doneSince = Date.now()
          return
        }
        if (previous === 'running' && (worldPhase === 'idle' || worldPhase === 'done')) {
          machineRef.current.celebrateUntil = Date.now() + 6000
          setSignal((n) => n + 1)
          speak('celebrate', { force: true })

          // 收工汇报：这次花了多久、写了多少 token。
          // 让庆祝那句先露个脸，4.6 秒后再报数据。
          const seconds = (Date.now() - machineRef.current.runningSince) / 1000
          const start = machineRef.current.usageAtStart || { total: 0, output: 0 }
          const outputDelta = Math.max(0, tokenRef.current.output - start.output)
          const totalDelta = Math.max(0, tokenRef.current.total - start.total)
          const report =
            outputDelta > 0
              ? { pool: 'report', vars: { t: formatDuration(seconds), o: formatTokens(outputDelta), a: formatTokens(totalDelta) } }
              : { pool: 'reportTime', vars: { t: formatDuration(seconds) } }
          if (reportTimerRef.current) reportTimerRef.current()
          reportTimerRef.current = scheduleOnce(() => {
            reportTimerRef.current = null
            speak(report.pool, { force: true, vars: report.vars })
          }, 4600)
        }
      }, [worldPhase, speak, scheduleOnce])

      // 组件卸载时把还没响的汇报定时器清掉。
      React.useEffect(
        () => () => {
          if (reportTimerRef.current) reportTimerRef.current()
        },
        [],
      )

      // 状态机主循环：算一步、播一步、排下一步。输入一变就立刻重算。
      React.useEffect(() => {
        if (prefs.hidden) return undefined
        // 一个动画都没有时不空转（花名册到位/导入成功后会因为 rosterSeq 变化重启）。
        if (catalog.assets.length === 0) return undefined
        let cancelled = false
        let dispose = null
        const schedule = (fn, ms) => {
          if (timer && typeof timer.timeout === 'function') dispose = timer.timeout(fn, ms)
          else {
            const id = window.setTimeout(fn, ms)
            dispose = () => window.clearTimeout(id)
          }
        }
        const step = () => {
          if (cancelled) return
          const decision = plan()
          // 只有真的换动画才重挂 <img>：同一个动作重新挂载会把 GIF 从头播。
          if (decision.asset.f !== assetRef.current.f) setToken((n) => n + 1)
          assetRef.current = decision.asset
          setAsset(decision.asset)
          setActivity(decision.activity)
          setMachineState(decision.state)
          // 只在「该说什么」真的变了的时候开口，所以状态内换动作不会一直叨叨。
          if (decision.say) {
            if (decision.say !== sayRef.current) {
              const summary = worldRef.current
              speak(decision.say, { n: decision.say === 'attention' ? summary.waiting : summary.total })
            }
            sayRef.current = decision.say
          } else {
            sayRef.current = null
          }
          schedule(step, decision.delay)
        }
        step()
        return () => {
          cancelled = true
          if (dispose) dispose()
        }
      }, [plan, timer, prefs.hidden, prefs.rate, prefs.talk, prefs.pet, signal, pinned, dragging, worldPhase, speak, rosterSeq])

      // 窗口变小的时候别把鱼留在屏幕外。
      React.useEffect(() => {
        const onResize = () => {
          setPrefs((current) => {
            const next = {
              ...current,
              x: clamp(current.x, 0, Math.max(0, window.innerWidth - current.size - 4)),
              y: clamp(current.y, 0, Math.max(0, window.innerHeight - current.size - 4)),
            }
            savePrefs(next)
            return next
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const onPointerDown = React.useCallback(
        (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          const startX = event.clientX
          const startY = event.clientY
          const base = { x: prefsRef.current.x, y: prefsRef.current.y }
          let moved = false
          const move = (moveEvent) => {
            const dx = moveEvent.clientX - startX
            const dy = moveEvent.clientY - startY
            if (!moved && Math.abs(dx) + Math.abs(dy) > 5) {
              moved = true
              // 拎起来的那一刻抽一个动作，整段拖拽就播它。
              machineRef.current.holdAsset = pick(pool(prefsRef.current.pet, 'hold'), assetRef.current)
              setDragging(true)
              speak('hold', { force: true })
            }
            if (!moved) return
            const size = prefsRef.current.size
            update({
              x: clamp(base.x - dx, 0, Math.max(0, window.innerWidth - size - 4)),
              y: clamp(base.y - dy, 0, Math.max(0, window.innerHeight - size - 4)),
            })
          }
          const finish = (upEvent) => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', finish)
            window.removeEventListener('pointercancel', finish)
            setDragging(false)
            if (moved) {
              // 放下也只播一个动作：抽一个落地反应，播完它自己那一轮就结束。
              const landed = pick(pool(prefsRef.current.pet, 'drop'), machineRef.current.holdAsset)
              machineRef.current.dropAsset = landed
              machineRef.current.dropUntil = Date.now() + Math.max(DROP_MIN_MS, landed.ms || 1600)
              setSignal((n) => n + 1)
              speak('drop', { force: true })
              return
            }
            if (upEvent && upEvent.detail >= 2) return // 双击由 onDoubleClick 处理
            poke()
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', finish)
          window.addEventListener('pointercancel', finish)
        },
        [poke, update, speak],
      )

      const size = prefs.size

      if (prefs.hidden) {
        return h(
          'div',
          { style: { position: 'fixed', right: 14, bottom: 104, zIndex: 60, pointerEvents: 'auto' } },
          h(
            'button',
            {
              type: 'button',
              title: t('show'),
              onClick: () => {
                update({ hidden: false })
                speak('show', { force: true, reveal: true })
              },
              style: {
                width: 40,
                height: 40,
                borderRadius: 20,
                border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
                background: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.9))',
                boxShadow: '0 4px 12px rgba(0,0,0,0.22)',
                cursor: 'pointer',
                fontSize: 20,
                lineHeight: 1,
              },
            },
            '🐟',
          ),
        )
      }

      const pet = h(
        'div',
        {
          onPointerDown,
          onDoubleClick: (event) => {
            event.preventDefault()
            setPanelOpen((open) => !open)
          },
          onContextMenu: (event) => {
            event.preventDefault()
            setPanelOpen((open) => !open)
          },
          title: `${asset.n} · ${t('hint')}`,
          style: {
            position: 'fixed',
            right: prefs.x,
            bottom: prefs.y,
            width: size,
            height: size,
            zIndex: 60,
            pointerEvents: 'auto',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
            // 被拎着就歪着、稍微放大一点；放下时播一下落地回弹。
            transform: dragging ? 'rotate(-6deg) scale(1.06)' : 'rotate(0deg) scale(1)',
            transformOrigin: '50% 90%',
            animation: machineState === 'drop' ? 'dsh-fish-pet-drop 420ms ease' : 'none',
            transition: dragging ? 'transform 120ms ease' : 'right 140ms ease, bottom 140ms ease, transform 180ms ease',
          },
        },
        h('img', {
          key: `${asset.f}#${token}`,
          src: srcOf(asset),
          alt: asset.n,
          draggable: false,
          onError: () => setImageFailures((n) => n + 1),
          style: {
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            pointerEvents: 'none',
            filter: 'drop-shadow(0 8px 12px rgba(0,0,0,0.28))',
          },
        }),
      )

      const panelWidth = 306
      // 面板和气泡各自占用鱼的一侧：面板优先放上方，气泡就自动让到另一侧，互不遮挡。
      // （之前只按「窗口能不能装下」来限位，结果把面板压到窗口底部，正好盖住鱼。）
      const panelGap = 8
      const petTop = window.innerHeight - prefs.y - size
      const spaceAbove = Math.max(0, petTop - panelGap - 12)
      const spaceBelow = Math.max(0, prefs.y - panelGap - 12)
      const placeAbove = spaceAbove >= spaceBelow
      const sideSpace = placeAbove ? spaceAbove : spaceBelow
      const panelMaxHeight = Math.max(160, Math.min(540, sideSpace))
      const panelVertical = placeAbove ? { bottom: prefs.y + size + panelGap } : { top: petTop + panelGap }
      const panelRight = clamp(prefs.x + size / 2 - panelWidth + 56, 10, Math.max(10, window.innerWidth - panelWidth - 10))
      const keyword = query.trim().toLowerCase()
      // 注意：这里在 hidden 的提前 return 之后，所以只能用普通计算，不能上 useMemo（hooks 顺序）。
      const activeAssets = petAssets(prefs.pet)
      const visible =
        keyword === '' ? activeAssets : activeAssets.filter((item) => item.n.toLowerCase().includes(keyword))
      // res/ 里还没导入的压缩包（只有 Host 半边给了运行时花名册才知道）。
      const resArchives = catalog.res && Array.isArray(catalog.res.archives) ? catalog.res.archives : []
      const pendingArchives = catalog.res && Array.isArray(catalog.res.pending) ? catalog.res.pending : []
      const readyArchives = resArchives.filter((item) => item.pet !== '')
      const noAssets = catalog.assets.length === 0

      // 干活时常驻的状态条：干活中/等你回答，其余时间只有说话时才出现。
      const stickyKey = worldPhase === 'running' ? 'working' : worldPhase === 'attention' ? 'waiting' : null
      const elapsedSeconds =
        worldPhase === 'running' ? Math.max(0, Math.floor((Date.now() - machineRef.current.runningSince) / 1000)) : 0
      void beat

      // 气泡：默认在鱼上方；面板占了上方时它就去下方；答题卡在的时候就给答题卡让位。
      const bubbleAbove = pendingQuestion !== null ? !placeAbove : panelOpen ? !placeAbove : true
      // 情绪决定描边颜色；color-mix 不被支持时退回普通描边色。
      const bubbleTint = bubble && bubble.mood ? MOOD_TINT[bubble.mood] : null
      const bubbleBorderColor = bubbleTint
        ? `color-mix(in srgb, ${bubbleTint} 60%, var(--dsw-alias-border-l1, rgba(127,127,127,0.35)))`
        : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))'
      // 连续 3 次图片加载失败 → 占用气泡位置显示一条说明（带重扫/导入按钮，可以关掉）。
      const smallButtonStyle = {
        font: 'inherit',
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      }
      const noticeNode =
        noticeHidden || imageFailures < 3
          ? null
          : h(
              'div',
              { style: { ...NOTICE_STYLE, right: clamp(prefs.x, 8, Math.max(8, window.innerWidth - 260)), bottom: prefs.y + size + 6 } },
              [
                h('div', { key: 'text' }, `🐟 ${t('loadFail')} —— ${t('buildHint')}`),
                h('div', { key: 'row', style: { marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' } }, [
                  h(
                    'button',
                    {
                      key: 'rescan',
                      type: 'button',
                      disabled: rosterState === 'loading',
                      onClick: () => {
                        setImageFailures(0)
                        void refreshRoster({ force: true, loud: true })
                      },
                      style: smallButtonStyle,
                    },
                    `⟳ ${t('rescan')}`,
                  ),
                  h(
                    'button',
                    { key: 'import', type: 'button', disabled: importing, onClick: () => void importFromRes(false), style: smallButtonStyle },
                    importing ? t('importing') : `${t('import')} ${t('archive')}`,
                  ),
                  h(
                    'button',
                    {
                      key: 'close',
                      type: 'button',
                      onClick: () => setNoticeHidden(true),
                      style: smallButtonStyle,
                    },
                    '✕',
                  ),
                ]),
              ],
            )
      const bubbleNode =
        noticeNode !== null
          ? noticeNode
          : bubble === null && stickyKey === null
          ? null
          : h(
              'div',
              {
                onClick: () => speak(sayRef.current || 'muse', { force: true }),
                title: t('sayOne'),
                style: {
                  position: 'fixed',
                  right: clamp(prefs.x, 8, Math.max(8, window.innerWidth - 260)),
                  ...(bubbleAbove ? { bottom: prefs.y + size + 6 } : { top: window.innerHeight - prefs.y + 6 }),
                  maxWidth: 240,
                  zIndex: 62,
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                  padding: '6px 10px',
                  borderRadius: 10,
                  border: `1px solid ${bubbleBorderColor}`,
                  background: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.97))',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
                  fontSize: 12,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              [
                stickyKey === null
                  ? null
                  : h(
                      'div',
                      {
                        key: 'status',
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--dsw-alias-brand-primary, inherit)',
                        },
                      },
                      h('span', {
                        key: 'dot',
                        style: {
                          display: 'inline-block',
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          background: 'var(--dsw-alias-brand-primary, #4a8)',
                          animation: 'dsh-fish-pet-pulse 1.4s ease-in-out infinite',
                        },
                      }),
                      t(stickyKey),
                      stickyKey === 'working' ? ` ${elapsedSeconds}s` : null,
                    ),
                bubble === null
                  ? null
                  : h(
                      'div',
                      { key: 'text', style: { marginTop: stickyKey === null ? 0 : 4 } },
                      bubble.text,
                    ),
                h('div', {
                  key: 'tail',
                  style: {
                    position: 'absolute',
                    right: 16,
                    [bubbleAbove ? 'bottom' : 'top']: -5,
                    width: 10,
                    height: 10,
                    transform: 'rotate(45deg)',
                    background: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.97))',
                    ...(bubbleAbove
                      ? { borderRight: `1px solid ${bubbleBorderColor}`, borderBottom: `1px solid ${bubbleBorderColor}` }
                      : { borderLeft: `1px solid ${bubbleBorderColor}`, borderTop: `1px solid ${bubbleBorderColor}` }),
                  },
                }),
              ],
            )

      const buttonStyle = {
        font: 'inherit',
        fontSize: 11,
        padding: '3px 8px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }

      // ── 答题卡（方案 B）：官方卡片照常在会话里挂着，这边只是「点一下更快」。 ──
      const questionOptions =
        pendingQuestion === null
          ? []
          : pendingQuestion.question.options.filter(
              (option) => option && typeof option.label === 'string' && option.label !== '',
            )
      const cardVertical = placeAbove ? { bottom: prefs.y + size + 6 } : { top: window.innerHeight - prefs.y + 6 }
      const answerCard =
        pendingQuestion === null
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'fixed',
                  right: clamp(prefs.x, 8, Math.max(8, window.innerWidth - 292)),
                  ...cardVertical,
                  width: 272,
                  maxHeight: 320,
                  overflowY: 'auto',
                  zIndex: 63,
                  pointerEvents: 'auto',
                  padding: 10,
                  borderRadius: 12,
                  border: '1px solid var(--dsw-alias-brand-primary, rgba(80,140,255,0.9))',
                  background: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.97))',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  boxShadow: '0 12px 32px rgba(0,0,0,0.30)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                },
              },
              [
                h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
                  h('strong', { key: 'title', style: { fontSize: 12, flex: '1 1 auto' } }, t('answerTitle')),
                  h(
                    'button',
                    {
                      key: 'collapse',
                      type: 'button',
                      title: t('answerCollapse'),
                      onClick: () => {
                        // 只收宠物这边：官方那一题继续挂着等用户，我们不撤销它。
                        setPicked([])
                        pendingQuestion.dismiss()
                      },
                      style: { ...buttonStyle, padding: '1px 7px' },
                    },
                    `⌄ ${t('answerCollapse')}`,
                  ),
                  h(
                    'button',
                    {
                      key: 'custom',
                      type: 'button',
                      title: t('answerCustomTitle'),
                      onClick: () => {
                        // 自己填：把光标送到官方卡片的自定义输入框；不在这个会话就先切过去。
                        // 送到了才收起（focusCustom 自己回调 dismiss）—— 送不到就把卡留着。
                        setPicked([])
                        pendingQuestion.focusCustom()
                      },
                      style: { ...buttonStyle, padding: '1px 7px' },
                    },
                    `${t('answerCustom')} →`,
                  ),
                ]),
                h('div', { key: 'question', style: { fontSize: 12, lineHeight: 1.45, wordBreak: 'break-word' } }, [
                  pendingQuestion.question.header
                    ? h(
                        'div',
                        { key: 'header', style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, inherit)' } },
                        pendingQuestion.question.header,
                      )
                    : null,
                  h('div', { key: 'body', style: { whiteSpace: 'pre-wrap' } }, pendingQuestion.question.question),
                  pendingQuestion.question.detail
                    ? h(
                        'div',
                        {
                          key: 'detail',
                          style: {
                            marginTop: 2,
                            fontSize: 10,
                            color: 'var(--dsw-alias-label-secondary, inherit)',
                            whiteSpace: 'pre-wrap',
                          },
                        },
                        pendingQuestion.question.detail,
                      )
                    : null,
                ]),
                h(
                  'div',
                  { key: 'options', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  questionOptions.map((option) =>
                    h(
                      'button',
                      {
                        key: option.label,
                        type: 'button',
                        title: option.description || option.label,
                        onClick: () => {
                          // 单选的题点一下就是提交；多选先勾，最后按「确定」。
                          if (pendingQuestion.multi !== true) {
                            answerQuestion(pendingQuestion, [option.label])
                            return
                          }
                          setPicked((current) =>
                            current.includes(option.label)
                              ? current.filter((value) => value !== option.label)
                              : [...current, option.label],
                          )
                        },
                        style: {
                          ...buttonStyle,
                          textAlign: 'left',
                          whiteSpace: 'normal',
                          lineHeight: 1.35,
                          ...(pendingQuestion.multi === true && picked.includes(option.label)
                            ? {
                                borderColor: 'var(--dsw-alias-brand-primary, rgba(80,140,255,0.9))',
                                color: 'var(--dsw-alias-brand-primary, inherit)',
                                fontWeight: 600,
                              }
                            : {}),
                        },
                      },
                      option.description
                        ? [
                            h('div', { key: 'label' }, option.label),
                            h(
                              'div',
                              {
                                key: 'desc',
                                style: {
                                  fontSize: 10,
                                  color: 'var(--dsw-alias-label-secondary, inherit)',
                                  fontWeight: 400,
                                },
                              },
                              option.description,
                            ),
                          ]
                        : option.label,
                    ),
                  ),
                ),
                pendingQuestion.multi === true
                  ? h('div', { key: 'confirm', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
                      h(
                        'button',
                        {
                          key: 'send',
                          type: 'button',
                          disabled: picked.length === 0,
                          onClick: () => answerQuestion(pendingQuestion, picked),
                          style: { ...buttonStyle, opacity: picked.length === 0 ? 0.55 : 1 },
                        },
                        t('answerSubmit'),
                      ),
                      h(
                        'span',
                        { key: 'count', style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, inherit)' } },
                        `${picked.length}/${questionOptions.length}`,
                      ),
                    ])
                  : null,
              ],
            )

      const panel = h(
        'div',
        {
          style: {
            position: 'fixed',
            right: panelRight,
            ...panelVertical,
            width: panelWidth,
            maxHeight: panelMaxHeight,
            zIndex: 61,
            pointerEvents: 'auto',
            padding: 10,
            borderRadius: 12,
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
            background: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.97))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.30)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            overflow: 'hidden',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
          h('strong', { style: { fontSize: 12, flex: '1 1 auto' } }, t('title')),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setShowDiag((open) => !open),
              style: { ...buttonStyle, padding: '1px 7px' },
              title: t('diag'),
            },
            'i',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setPanelOpen(false),
              style: { ...buttonStyle, padding: '1px 7px' },
              title: t('hide'),
            },
            '✕',
          ),
        ),
        h(
          'div',
          { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, inherit)', flex: '0 0 auto' } },
          `${t('state')}：${t(worldPhase)} · ${t('pet')}：${t(
            activity !== null ? activity : machineState === 'poke' ? 'pokeState' : machineState,
          )}`,
        ),
        // 宠物行常驻：只有一只的时候也要让用户看见「在哪加新宠物」。
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, flex: '0 0 auto', flexWrap: 'wrap' } },
          h('span', { style: { whiteSpace: 'nowrap' } }, t('petSwap')),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            catalog.pets.map((pet) =>
              h(
                'button',
                {
                  key: pet.id,
                  type: 'button',
                  title: `${pet.id} · ${pet.count} ${t('total')}`,
                  onClick: () => switchPet(pet.id),
                  style: {
                    ...buttonStyle,
                    borderColor:
                      prefs.pet === pet.id
                        ? 'var(--dsw-alias-brand-primary, rgba(80,140,255,0.9))'
                        : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
                    color: prefs.pet === pet.id ? 'var(--dsw-alias-brand-primary, inherit)' : 'inherit',
                    fontWeight: prefs.pet === pet.id ? 600 : 400,
                  },
                },
                pet.label,
              ),
            ),
            noAssets
              ? h(
                  'span',
                  { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } },
                  t('noAssets'),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              title: t('rescanTitle'),
              disabled: rosterState === 'loading',
              onClick: () => void refreshRoster({ force: true, loud: true }),
              style: { ...buttonStyle, opacity: rosterState === 'loading' ? 0.55 : 1 },
            },
            `⟳ ${t('rescan')}`,
          ),
          h(
            'button',
            {
              type: 'button',
              title: t('importTitle'),
              disabled: importing,
              onClick: () => void importFromRes(false),
              style: {
                ...buttonStyle,
                opacity: importing ? 0.55 : 1,
                borderColor:
                  pendingArchives.length > 0
                    ? 'var(--dsw-alias-brand-primary, rgba(80,140,255,0.9))'
                    : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
                color: pendingArchives.length > 0 ? 'var(--dsw-alias-brand-primary, inherit)' : 'inherit',
                fontWeight: pendingArchives.length > 0 ? 600 : 400,
              },
            },
            importing
              ? t('importing')
              : `${t('import')} ${t('archive')}${pendingArchives.length > 0 ? ` (${pendingArchives.length})` : ''}`,
          ),
          readyArchives.length > 0 && pendingArchives.length === 0
            ? h(
                'button',
                {
                  type: 'button',
                  title: t('importForceTitle'),
                  disabled: importing,
                  onClick: () => void importFromRes(true),
                  style: { ...buttonStyle, opacity: importing ? 0.55 : 1 },
                },
                t('importForce'),
              )
            : null,
        ),
        h(
          'div',
          { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, inherit)', flex: '0 0 auto' } },
          rosterNote !== null
            ? rosterNote
            : `${t('petHint')}（${t('roster')}：${
                catalog.source === 'runtime' ? t('rosterRuntime') : t('rosterBuilt')
              }${catalog.pets.length > 0 ? ` · ${catalog.pets.length} ${t('total')}` : ''}）`,
        ),
        showDiag
          ? h(
              'div',
              { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, inherit)', flex: '0 0 auto' } },
              `${t('diag')}：${t(sourceKey)} · ${t('sessions')}${world.total} · ${t('sRun')}${world.running} · ${t(
                'sWait',
              )}${world.waiting} · ${t('sDone')}${world.finished} · ${t('pets')}${petLabel(prefs.pet)}(${
                activeAssets.length
              }) · ${t('roster')}${catalog.source === 'runtime' ? t('rosterRuntime') : t('rosterBuilt')}/${rosterState}${
                catalog.scanMs > 0 ? ` ${catalog.scanMs}ms` : ''
              } · ${t('archive')}${readyArchives.length}(-${pendingArchives.length}) · dict:${localeInfo()} · ${formatTokens(
                tokenTotal,
              )} ${t('sTokens')} · ${t('sEvents')}${binding ? eventCountRef.current : '×'}`,
            )
          : null,
        h(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, flex: '0 0 auto' } },
          h('span', { style: { whiteSpace: 'nowrap' } }, t('size')),
          h('input', {
            type: 'range',
            min: MIN_SIZE,
            max: MAX_SIZE,
            step: 10,
            value: size,
            onChange: (event) => update({ size: clamp(Number(event.target.value), MIN_SIZE, MAX_SIZE) }),
            style: { flex: '1 1 auto' },
          }),
          h('span', { style: { width: 40, textAlign: 'right' } }, `${size}px`),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, flex: '0 0 auto' } },
          h('span', { style: { whiteSpace: 'nowrap' } }, t('rate')),
          h(
            'div',
            { style: { display: 'flex', gap: 4 } },
            RATE_ORDER.map((id) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  onClick: () => update({ rate: id }),
                  style: {
                    ...buttonStyle,
                    // 选中态只用品牌色描边 + 加粗：直接拿 brand 当底色会在深色主题里变成黑底黑字。
                    borderColor:
                      prefs.rate === id
                        ? 'var(--dsw-alias-brand-primary, rgba(80,140,255,0.9))'
                        : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
                    color: prefs.rate === id ? 'var(--dsw-alias-brand-primary, inherit)' : 'inherit',
                    fontWeight: prefs.rate === id ? 600 : 400,
                  },
                },
                t(id),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 6, flex: '0 0 auto' } },
          h('button', { type: 'button', style: buttonStyle, onClick: poke }, t('poke')),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              onClick: () => speak(sayRef.current || 'muse', { force: true }),
            },
            t('sayOne'),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => update({ talk: prefs.talk === false }),
              style: {
                ...buttonStyle,
                borderColor:
                  prefs.talk === false
                    ? 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))'
                    : 'var(--dsw-alias-brand-primary, rgba(80,140,255,0.9))',
                color: prefs.talk === false ? 'inherit' : 'var(--dsw-alias-brand-primary, inherit)',
                fontWeight: prefs.talk === false ? 400 : 600,
              },
            },
            `${t('talk')}：${prefs.talk === false ? t('talkOff') : t('talkOn')}`,
          ),
          pinned === null
            ? null
            : h('button', { type: 'button', style: buttonStyle, onClick: () => setPinned(null) }, t('auto')),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              onClick: () => {
                // 藏起来只收宠物这张卡（官方那一题不动，用户还能在会话里答）；
                // handler 那边也读 QUESTIONS.hidden，之后不会再接新的。
                QUESTIONS.dismissActive()
                update({ hidden: true })
              },
            },
            t('hide'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              onClick: () => update({ x: DEFAULT_PREFS.x, y: DEFAULT_PREFS.y }),
            },
            t('reset'),
          ),
        ),
        h('input', {
          type: 'search',
          value: query,
          placeholder: `${t('search')} (${activeAssets.length})`,
          onChange: (event) => setQuery(event.target.value),
          style: {
            font: 'inherit',
            fontSize: 11,
            padding: '4px 7px',
            borderRadius: 7,
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
            background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
            color: 'inherit',
            flex: '0 0 auto',
          },
        }),
        h(
          'div',
          {
            style: {
              flex: '1 1 auto',
              // 固定行高 + 自己的滚动条：列表只会滚动，不会被 flex 压扁成一条条细缝。
              minHeight: 120,
              overflowY: 'auto',
              overflowX: 'hidden',
              display: 'grid',
              // minmax(0, 1fr)：不加这个，nowrap 的按钮会把轨道撑成 min-content 宽度。
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gridAutoRows: '24px',
              gap: 4,
              alignContent: 'start',
              padding: 4,
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
            },
          },
          visible.length === 0
            ? h(
                'div',
                {
                  style: {
                    gridColumn: '1 / -1',
                    fontSize: 11,
                    padding: '6px 4px',
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                  },
                },
                t('noMatch'),
              )
            : visible.map((item) =>
                h(
                  'button',
                  {
                    key: item.f,
                    type: 'button',
                    title: item.f,
                    onClick: () => {
                  setPinned(item.f)
                  speak('pin', { force: true })
                },
                    style: {
                      ...buttonStyle,
                      boxSizing: 'border-box',
                      height: 24,
                      lineHeight: '22px',
                      padding: '0 7px',
                      minWidth: 0,
                      textAlign: 'left',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      borderColor:
                        pinned === item.f || asset.f === item.f
                          ? 'var(--dsw-alias-brand-primary, rgba(80,140,255,0.9))'
                          : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
                      color: pinned === item.f ? 'var(--dsw-alias-brand-primary, inherit)' : 'inherit',
                      fontWeight: pinned === item.f ? 600 : 400,
                    },
                  },
                  item.n,
                ),
              ),
        ),
      )

      // 一个动画都没有（新克隆还没导入素材 / 素材被删了）：给一张能自救的卡片。
      // 面板本来要靠点宠物才打得开，这时候必须让按钮直接出现在卡片上。
      if (noAssets) {
        return h(
          'div',
          { style: { ...NOTICE_STYLE, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 280 } },
          h('div', { key: 'title', style: { fontWeight: 600 } }, `🐟 ${t('noAssets')}`),
          h('div', { key: 'hint' }, t('noAssetsHint')),
          h('div', { key: 'row', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
            h(
              'button',
              {
                key: 'import',
                type: 'button',
                disabled: importing,
                onClick: () => void importFromRes(false),
                style: { ...buttonStyle, opacity: importing ? 0.55 : 1 },
              },
              importing ? t('importing') : `${t('import')} ${t('archive')}`,
            ),
            h(
              'button',
              { key: 'rescan', type: 'button', disabled: rosterState === 'loading', onClick: () => void refreshRoster({ force: true, loud: true }), style: { ...buttonStyle, opacity: rosterState === 'loading' ? 0.55 : 1 } },
              `⟳ ${t('rescan')}`,
            ),
          ]),
          rosterNote !== null
            ? h('div', { key: 'note', style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, inherit)' } }, rosterNote)
            : null,
        )
      }

      return h(React.Fragment, null, pet, bubbleNode, panelOpen ? panel : null, answerCard)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        /**
         * 词典。
         *
         * 客户端插件是 `immediately` 挂载的，apply() 执行这一刻 `ctx.get('locale')`
         * 很可能还没准备好 —— 老写法「拿一次，拿不到就一辈子回退成原始 key」的症状
         * 就是面板上写着 petSwap / size / poke 这种原始 key（实测踩过）。
         * 所以这里不再在 apply 时定死，而是：
         *   - 登记与绑定都做成懒的：t() 每次被调用时再看一眼 service 在不在；
         *   - 同时用 locale/change 事件 + 两次短延时重试，兜住「服务晚到、之后又不重渲染」的情况。
         * bind() 返回的函数每次调用都现读语言与词典，所以绑一次之后切语言照样即时生效。
         */
        const localeState = { service: null, bound: null, registered: false, ids: new Set() }
        const registeredIds = new Set()
        const disposeRegistrations = []

        /** 服务在就（幂等地）登记词典；返回可用的服务本身。 */
        const ensureLocale = () => {
          const service = localeState.service || ctx.get('locale')
          if (!service || typeof service.bind !== 'function') return null
          localeState.service = service
          if (!localeState.registered) {
            localeState.registered = true
            // 写死 zh-CN/en 不够：真实 id 可能是 zh-Hans / zh 之类，一变就查不到。
            for (const id of ['zh-CN', 'zh-Hans', 'zh', 'en']) localeState.ids.add(id)
            try {
              const snapshot = typeof service.getLocale === 'function' ? service.getLocale() : null
              if (snapshot && Array.isArray(snapshot.locales)) {
                for (const definition of snapshot.locales) {
                  if (definition && typeof definition.id === 'string') localeState.ids.add(definition.id)
                }
              }
            } catch {
              /* 读不到语言表就用上面几个兜底 id */
            }
            for (const id of localeState.ids) {
              if (registeredIds.has(id)) continue
              try {
                const dispose = service.register('fish-pet', id, /^zh/i.test(id) ? DICT['zh-CN'] : DICT.en)
                registeredIds.add(id)
                if (typeof dispose === 'function') disposeRegistrations.push(dispose)
              } catch (error) {
                console.error(`dsh-fish-pet: locale dict for ${id} failed`, error)
              }
            }
          }
          return service
        }

        /** 稳定的翻译入口：服务晚到也能补上；绑一次之后不再重复绑。 */
        const t = (key, vars) => {
          if (localeState.bound === null) {
            const service = ensureLocale()
            if (service === null) return key
            try {
              localeState.bound = service.bind('fish-pet')
            } catch (error) {
              console.error('dsh-fish-pet: locale bind failed', error)
              return key
            }
          }
          return localeState.bound(key, vars)
        }

        // 挂载时先登记一次；服务晚到就靠事件 + 两次短延时补上。
        ctx.effect(() => {
          ensureLocale()
          let off = null
          try {
            if (typeof ctx.on === 'function') off = ctx.on('locale/change', () => ensureLocale())
          } catch {
            /* 没有这个事件也没关系，下面还有延时兜底 */
          }
          const timers = [300, 1500].map((ms) => window.setTimeout(() => ensureLocale(), ms))
          return () => {
            if (typeof off === 'function') off()
            for (const id of timers) window.clearTimeout(id)
            for (const dispose of disposeRegistrations.splice(0)) {
              try {
                dispose()
              } catch {
                /* 已经移除过 */
              }
            }
            localeState.registered = false
            localeState.bound = null
          }
        })

        /**
         * 待回答问题的投稿口（方案 B）。
         *
         * 和 locale 一样，客户端插件是 immediately 挂载的：apply() 这一刻 remote
         * 可能还没起来，所以也是「先试一次 + 短延时重试」，拿到 $on 才登记。
         * 一直拿不到就永远不登记 —— 界面没有任何变化，官方卡片那条路完全不受影响
         * （不显示、不提交，也就是「静默退化」）。
         *
         * 返回值就是答案，所以 handler 里先 next() 让官方照常挂上等待，
         * 再跟它赛跑（细节见 answerWithPet）。
         */
        const remoteState = { service: null, off: null }
        const ensureRemote = () => {
          if (remoteState.off !== null) return true
          const service = remoteState.service || ctx.get('remote')
          if (!service || typeof service.$on !== 'function') return false
          remoteState.service = service
          try {
            const dispose = service.$on('user-questions/request', function (request, next) {
              return answerWithPet(ctx, this, request, next)
            })
            remoteState.off = typeof dispose === 'function' ? dispose : () => {}
            return true
          } catch (error) {
            console.error('dsh-fish-pet: user-questions hook failed', error)
            return false
          }
        }

        ctx.effect(() => {
          ensureRemote()
          let off = null
          try {
            if (typeof ctx.on === 'function') off = ctx.on('connection/reset', () => ensureRemote())
          } catch {
            /* 没这个事件也没关系，下面还有延时兜底 */
          }
          // 覆盖「服务晚到」的常见窗口；拿到就自己停（ensureRemote 幂等）。
          const timers = [300, 1500, 4000, 10000].map((ms) => window.setTimeout(() => ensureRemote(), ms))
          return () => {
            if (typeof off === 'function') off()
            for (const id of timers) window.clearTimeout(id)
            if (remoteState.off !== null) {
              try {
                remoteState.off()
              } catch {
                /* 已经移除过 */
              }
              remoteState.off = null
            }
            // 插件停用：只收宠物这张卡，官方那一题照旧挂着。
            QUESTIONS.dismissActive()
          }
        })

        const timer = ctx.get('timer')

        // 被拎住/放下的那点表现力，用一次性的样式表；插件停掉时自动移除。
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          ctx.effect(() => styles.insert(PET_CSS))
        }

        // 兜底路线：直接订阅会话服务的 sessionStatus（getSnapshot/subscribe 对）。
        const uiSession = ctx.get('uiSession')
        const sessionStatus = uiSession && uiSession.sessionStatus
        const statusStore =
          sessionStatus &&
          typeof sessionStatus.getSnapshot === 'function' &&
          typeof sessionStatus.subscribe === 'function'
            ? {
                read: () => worldSummaryOf(sessionStatus.getSnapshot()),
                subscribe: (notify) => sessionStatus.subscribe(notify),
              }
            : null

        // 台词表现读当前语言，切换语言立刻生效。
        const activeLocale = () => {
          const service = ensureLocale()
          if (!service) return 'zh'
          try {
            const snapshot = typeof service.getLocale === 'function' ? service.getLocale() : null
            return snapshot && typeof snapshot.active === 'string' ? snapshot.active : 'zh'
          } catch {
            return 'zh'
          }
        }

        /** 诊断行里显示词典状态：`none` = 服务还没来，`unbound` = 没绑上，`nodict` = 没登记上。 */
        const localeInfo = () => {
          const service = ctx.get('locale')
          if (!service) return 'none'
          let active = '?'
          try {
            const snapshot = service.getLocale()
            active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : '?'
          } catch {
            active = 'err'
          }
          return `${active}${localeState.registered ? '' : '·nodict'}${localeState.bound === null ? '·unbound' : ''}`
        }

        // 会话事件流（干活播报用）：客户端会话控制器给的 binding.eventSource。
        const sessionsService = ctx.get('sessions')
        const Root = (slotProps) =>
          h(
            PetBoundary,
            null,
            h(FishPet, { ...slotProps, timer, t, statusStore, activeLocale, localeInfo, sessionsService }),
          )
        ctx.effect(() =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-fish-pet', order: 50, label: () => t('label') },
              Root,
            ),
          ),
        )
      },
    }
  },
})
