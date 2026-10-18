/**
 * 动作库测试。
 *
 * 这一层的核心主张是：**AI 不编关节角度，只做「选动作 + 给参数」**。
 * 所以测试要钉住这条链路的每一环都可靠：
 *   ① 人话 → 动作：能匹配、平票时选信息完整的、匹配不上要**如实说不上**（不能硬猜一个）
 *   ② 动作 → 关键帧：时间轴单调、循环动作首尾接得上、骨架缺件时不崩
 *   ③ 采样：两端夹住不外推、smoothstep 单调、循环取模正确
 *   ④ 组合动作：三段能真的拼成一段（举枪攻击 = 瞄准→开火→收枪）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MOTIONS, listMotions, getMotion, matchMotion, interpretMotionRequest,
  sampleChannel, buildAnimation, sampleAnimation, sampleNamedAnimation,
  mergeAnimations, mirrorAnimation, humanoidBoneNames,
} from '../lib/motion.js'

const FULL_BONES = humanoidBoneNames().map((name) => ({ name }))
const fakeSkeleton = { bones: FULL_BONES }

/* ---------------- 人话 → 动作 ---------------- */

test('人话匹配：用户真会说的说法都要能对上', () => {
  const cases = [
    ['举枪攻击', 'aim_fire'],
    ['举枪射击', 'aim_fire'],
    ['走动', 'walk'],
    ['走路', 'walk'],
    ['奔跑', 'run'],
    ['我要他跑起来', 'run'],
    ['受击', 'hit'],
    ['死亡倒下', 'die'],
    ['待机呼吸', 'idle'],
    ['扔手雷', 'throw'],
    ['蹲下', 'crouch'],
    ['跳一下', 'jump'],
    ['砍一刀', 'slash'],
    ['挥砍', 'slash'],
    ['左手挥一下', 'wave'],
    ['walk', 'walk'],
    ['idle', 'idle'],
  ]
  for (const [text, expected] of cases) {
    const r = matchMotion(text)
    assert.equal(r.ok, true, `「${text}」应该匹配到动作`)
    assert.equal(r.id, expected, `「${text}」应匹配 ${expected}，实际 ${r.id}（匹配词：${r.matched}）`)
  }
})

test('平票时优先**组合动作**（举枪攻击要拿到三段动作，不是单帧扣扳机）', () => {
  const r = matchMotion('举枪攻击')
  assert.equal(r.id, 'aim_fire')
  assert.ok(getMotion('aim_fire').sequence, 'aim_fire 应该是组合动作')
  // fire 自己不能再抢这个词
  assert.ok(!getMotion('fire').aliases.includes('举枪攻击'), 'fire 不该再认「举枪攻击」')
})

test('匹配不上时**如实说不上**，并给出候选（绝不硬猜一个动作）', () => {
  const r = matchMotion('跳舞转圈顺便翻个跟头')
  assert.equal(r.ok, false)
  assert.equal(r.id, null)
  assert.match(r.error, /没匹配到动作/)
  assert.ok(r.error.includes('待机') || r.error.includes('走动'), '报错里要列出可用动作')
})

test('从话里额外读出参数：快/慢、夸张/轻微、镜像、循环', () => {
  assert.equal(interpretMotionRequest('快速奔跑').params.speed, 1.5)
  assert.equal(interpretMotionRequest('慢速走动').params.speed, 0.6)
  assert.equal(interpretMotionRequest('夸张地挥手').params.amplitude, 1.35)
  assert.equal(interpretMotionRequest('轻微挥手').params.amplitude, 0.7)
  assert.equal(interpretMotionRequest('左手挥一下').params.mirror, true)
  assert.equal(interpretMotionRequest('走动循环播放').params.forceLoop, true)
  const ok = interpretMotionRequest('快速奔跑')
  assert.equal(ok.interpreted.动作, '奔跑')
})

/* ---------------- 采样 ---------------- */

test('sampleChannel：两端夹住（不外推）、中间单调平滑', () => {
  const keys = [[0, 0], [0.5, 100], [1, 0]]
  assert.equal(sampleChannel(keys, -1), 0, '小于 0 要夹到首值')
  assert.equal(sampleChannel(keys, 2), 0, '大于 1 要夹到末值')
  assert.equal(sampleChannel(keys, 0), 0)
  assert.equal(sampleChannel(keys, 1), 0)
  assert.ok(Math.abs(sampleChannel(keys, 0.5) - 100) < 1e-9)
  // 上升段必须单调
  let prev = -Infinity
  for (let t = 0; t <= 0.5; t += 0.05) {
    const v = sampleChannel(keys, t)
    assert.ok(v >= prev - 1e-9, `上升段在 t=${t} 不单调`)
    prev = v
  }
  // smoothstep 的中点值应比线性高（缓入缓出）
  const linearMid = sampleChannel([[0, 0], [1, 100]], 0.25)
  assert.ok(Math.abs(linearMid - 15.625) < 1e-6, `smoothstep t=0.25 应约 15.625，实际 ${linearMid}`)
  assert.equal(sampleChannel([], 0.5), 0, '空通道返回 0 而不是 NaN')
})

/* ---------------- 动作 → 关键帧 ---------------- */

test('每个动作的关键帧都合法：时间在 0~1、单调递增、值有限', () => {
  for (const motion of MOTIONS) {
    if (motion.sequence) continue // 组合动作没有自己的通道
    assert.ok(motion.channels && Object.keys(motion.channels).length > 0, `${motion.id} 没有通道`)
    for (const [bone, channel] of Object.entries(motion.channels)) {
      for (const [prop, keys] of Object.entries(channel)) {
        assert.ok(Array.isArray(keys) && keys.length >= 2, `${motion.id}.${bone}.${prop} 关键帧太少`)
        let last = -1
        for (const key of keys) {
          assert.equal(key.length, 2, `${motion.id}.${bone}.${prop} 关键帧格式错`)
          assert.ok(Number.isFinite(key[0]) && key[0] >= 0 && key[0] <= 1, `${motion.id}.${bone}.${prop} 时间越界：${key[0]}`)
          assert.ok(Number.isFinite(key[1]), `${motion.id}.${bone}.${prop} 值不是数字`)
          assert.ok(key[0] >= last, `${motion.id}.${bone}.${prop} 时间不单调`)
          last = key[0]
        }
      }
    }
  }
})

test('循环动作首尾要接上（不接就会播完"跳一下"）', () => {
  for (const motion of MOTIONS.filter((m) => m.loop)) {
    for (const [bone, channel] of Object.entries(motion.channels)) {
      for (const [prop, keys] of Object.entries(channel)) {
        const first = keys[0][1]
        const last = keys[keys.length - 1][1]
        assert.ok(Math.abs(first - last) < 1e-6,
          `循环动作 ${motion.id}.${bone}.${prop} 首尾不接：${first} vs ${last}（播完会跳）`)
      }
    }
  }
})

test('循环动作的每个通道都必须从 t=0 开始（否则播放头回 0 会闪）', () => {
  for (const motion of MOTIONS.filter((m) => m.loop)) {
    for (const [bone, channel] of Object.entries(motion.channels)) {
      for (const [prop, keys] of Object.entries(channel)) {
        assert.equal(keys[0][0], 0, `${motion.id}.${bone}.${prop} 首帧不在 t=0`)
      }
    }
  }
})

test('buildAnimation：出生效的关键帧，缺的骨骼跳过并警告（不崩）', () => {
  const full = buildAnimation({ skeleton: fakeSkeleton, motionId: 'walk' })
  assert.equal(full.ok, true, full.error)
  assert.equal(full.animation.loop, true)
  assert.ok(Object.keys(full.animation.channels).length > 5)
  assert.equal(full.missingBones.length, 0)

  // 只有 1 根骨骼的骨架：walk 的通道大部分都要跳过
  const tiny = buildAnimation({ skeleton: { bones: [{ name: 'hip' }] }, motionId: 'walk' })
  assert.equal(tiny.ok, true, '只要有一条通道可用就该成功')
  assert.deepEqual(Object.keys(tiny.animation.channels), ['hip'])
  assert.ok(tiny.missingBones.length > 0)
  assert.ok(tiny.warning.includes('骨架里没有'))

  // 完全对不上（骨骼名全不同）→ 明确失败
  const none = buildAnimation({ skeleton: { bones: [{ name: 'b1' }, { name: 'b2' }] }, motionId: 'walk' })
  assert.equal(none.ok, false)
  assert.match(none.error, /一个都没有/)
})

test('buildAnimation：speed 改时长、amplitude 改幅度、mirror 换左右并反转旋转', () => {
  const base = buildAnimation({ skeleton: fakeSkeleton, motionId: 'walk' })
  const fast = buildAnimation({ skeleton: fakeSkeleton, motionId: 'walk', speed: 2 })
  assert.ok(Math.abs(base.animation.duration / fast.animation.duration - 2) < 1e-6, 'speed=2 时长应减半')

  const strong = buildAnimation({ skeleton: fakeSkeleton, motionId: 'walk', amplitude: 2 })
  const baseRot = base.animation.channels.thigh_L.rotation[0][1]
  const strongRot = strong.animation.channels.thigh_L.rotation[0][1]
  assert.ok(Math.abs(strongRot - baseRot * 2) < 1e-6, `amplitude=2 幅度应翻倍：${baseRot} → ${strongRot}`)

  const mirrored = buildAnimation({ skeleton: fakeSkeleton, motionId: 'walk', mirror: true })
  assert.ok(mirrored.animation.channels.thigh_R, '镜像后左腿通道应换到右腿')
  const leftBase = base.animation.channels.thigh_L.rotation[0][1]
  const rightMirror = mirrored.animation.channels.thigh_R.rotation[0][1]
  assert.ok(Math.abs(rightMirror + leftBase) < 1e-6, `镜像要反转旋转：${leftBase} vs ${rightMirror}`)
})

test('组合动作：aim_fire 真的是「瞄准→开火→收枪」拼起来的，不是单帧', () => {
  const r = buildAnimation({ skeleton: fakeSkeleton, motionId: 'aim_fire' })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.animation.sequence, ['aim', 'fire', 'aim'])
  assert.ok(r.animation.duration >= 0.9, `三段动作时长该接近 1s，实际 ${r.animation.duration}`)
  // 手臂在过程中要真的抬起来（值域跨度够大）
  const arm = r.animation.channels.upper_arm_L.rotation
  const values = arm.map((k) => k[1])
  const span = Math.max(...values) - Math.min(...values)
  assert.ok(span > 50, `瞄准动作手臂角度跨度应 > 50 度，实际 ${span}`)
  // 关键帧时间必须仍然单调（拼接容易在这里出错）
  let last = -1
  for (const [t] of arm) { assert.ok(t >= last, '拼接后时间不单调'); last = t }
  assert.ok(arm[arm.length - 1][0] <= 1.0001, '拼接后不能超出 1')
})

test('mergeAnimations：拼接后总时长是各段之和，通道正确合并', () => {
  const a = { duration: 1, channels: { hip: { y: [[0, 0], [1, 10]] } } }
  const b = { duration: 3, channels: { hip: { y: [[0, 10], [1, 20]] }, torso: { rotation: [[0, 0], [1, 5]] } } }
  const merged = mergeAnimations([a, b])
  assert.equal(merged.duration, 4)
  assert.ok(merged.channels.hip.y.length >= 3, 'hip.y 应该把两段都拼进来')
  assert.ok(merged.channels.torso, '第二段独有的通道也要在')
  assert.ok(merged.channels.hip.y.every(([t]) => t >= 0 && t <= 1), '时间要重新映射到 0~1')
  // 拼接处去重：不应出现两个几乎相同的时间点
  const times = merged.channels.hip.y.map(([t]) => t)
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] > 1e-6, '拼接处有重复时间点')
  assert.deepEqual(mergeAnimations([]).channels, {})
})

/* ---------------- 采样整段动画 ---------------- */

test('sampleAnimation：循环取模、非循环夹住、不存在的骨骼不出现在 pose 里', () => {
  const walk = buildAnimation({ skeleton: fakeSkeleton, motionId: 'walk' }).animation
  const t0 = sampleAnimation(walk, 0)
  const tEnd = sampleAnimation(walk, walk.duration)
  // 循环动作：播一整轮后应该回到起点
  for (const bone of Object.keys(t0)) {
    assert.ok(Math.abs((t0[bone].rotation ?? 0) - (tEnd[bone].rotation ?? 0)) < 1e-6,
      `循环动作 ${bone} 播完没回到起点（会跳）`)
  }
  // 超出时长：循环的取模、非循环的夹住
  const over = sampleAnimation(walk, walk.duration * 1.5)
  assert.ok(over.thigh_L, '循环动作超时后仍要有姿态（取模）')
  const die = buildAnimation({ skeleton: fakeSkeleton, motionId: 'die' }).animation
  const a = sampleAnimation(die, die.duration)
  const b = sampleAnimation(die, die.duration * 5)
  assert.deepEqual(a, b, '非循环动作超时后要停在最后一帧')
})

test('sampleNamedAnimation：从 skeleton.animations 里按名取', () => {
  const walk = buildAnimation({ skeleton: fakeSkeleton, motionId: 'walk' }).animation
  const skeleton = { ...fakeSkeleton, animations: { walk } }
  assert.ok(sampleNamedAnimation(skeleton, 'walk', 0.2))
  assert.equal(sampleNamedAnimation(skeleton, '不存在', 0), null)
})

test('mirrorAnimation：左右互换 + 旋转反转，且可重复镜像回原样', () => {
  const wave = buildAnimation({ skeleton: fakeSkeleton, motionId: 'wave' }).animation
  const mirrored = mirrorAnimation(wave)
  assert.ok(mirrored.channels.upper_arm_L, '挥手（右手）镜像后应在左手')
  const back = mirrorAnimation(mirrored)
  assert.ok(back.channels.upper_arm_R, '再镜像一次应回到右手')
  assert.ok(Math.abs(back.channels.upper_arm_R.rotation[0][1] - wave.channels.upper_arm_R.rotation[0][1]) < 1e-6)
})

/* ---------------- 库本身 ---------------- */

test('动作库完整性：13 个动作、id 唯一、每个都有中文名/别名/说明', () => {
  const list = listMotions()
  assert.equal(list.length, MOTIONS.length)
  assert.ok(list.length >= 13, `动作太少：${list.length}`)
  const ids = new Set()
  for (const motion of MOTIONS) {
    assert.ok(motion.id, '缺 id')
    assert.ok(!ids.has(motion.id), `id 重复：${motion.id}`)
    ids.add(motion.id)
    assert.ok(motion.label, `${motion.id} 缺中文名`)
    assert.ok(Array.isArray(motion.aliases) && motion.aliases.length > 0, `${motion.id} 缺别名（AI 就匹配不到）`)
    assert.ok(motion.note, `${motion.id} 缺说明（AI 靠它选动作）`)
    assert.ok(motion.duration > 0)
    if (!motion.sequence) {
      assert.ok(motion.channels && Object.keys(motion.channels).length > 0, `${motion.id} 没有通道也没有子动作`)
    }
  }
  // getMotion 大小写不敏感
  assert.ok(getMotion('WALK'))
  assert.equal(getMotion('不存在'), null)
})

test('动作库只用在**对应模板**里真有的骨骼名（拼错一个就会静默不动）', async () => {
  /* 动作分两组：侧/前视（人形）、正俯视（俯视士兵）。俯视模板没有 thigh/shin/torso，
   * 所以不能拿人形骨骼表去校验俯视动作 —— 按 view 分别对表才是有意义的断言。 */
  const { TOPDOWN_SLOTS } = await import('../lib/rig.js')
  const side = new Set(humanoidBoneNames())
  const top = new Set(TOPDOWN_SLOTS.map((s) => s.name))
  for (const motion of MOTIONS) {
    if (motion.sequence) continue
    const known = motion.view === 'top' ? top : side
    for (const bone of Object.keys(motion.channels)) {
      assert.ok(known.has(bone),
        `${motion.id}（view=${motion.view ?? 'side'}）用了模板里没有的骨骼：${bone}`)
    }
  }
})
