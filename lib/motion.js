/**
 * 动作库（motion library）：把「举枪攻击 / 走动 / 待机」这类**人话**变成关键帧动画。
 *
 * ┌─ 为什么这么设计（这是整个功能最关键的一个判断）────────────────────────────┐
 * │ AI 直接编关节角度是**不可靠**的：让它"生成一个举枪动作"，它给你的角度              │
 * │ 十次有八次是肢体折断的。这不是模型笨，是"美术调过的角度"这种知识不在语言模型里。      │
 * │                                                                        │
 * │ 所以正确的分工是：                                                       │
 * │   **AI 只负责「理解你要什么动作」+「给参数」，角度由数据化的动作库提供。**           │
 * │   动作库里的角度是有人调过、可复用、可测试的；AI 的输出退化成一次**检索 + 参数化**，   │
 * │   而检索和参数化这两件事它是可靠的。                                        │
 * │                                                                        │
 * │ 这和「代码表」是同一个道理：不确定性收进数据，代码只做确定的事。                  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 关键帧格式（跟 skeleton.animations 一致）：
 *   channels: { 骨骼名: { rotation: [[t, deg], …], y: [[t, px], …], x: [...] } }
 *   t 是**归一化时间 0~1**（跟时长解耦：改速度不用改关键帧）
 *
 * 循环动作（走动/待机）要把首尾接上，否则播完会"跳一下"；非循环动作（攻击/死亡）不用。
 */
import { HUMANOID_SLOTS } from './rig.js'

/** 线性插值采样一个通道。t 超出范围时夹在两端（不 extrapolate，免得动作飞到天上去）。 */
export function sampleChannel(keys, t) {
  if (!Array.isArray(keys) || keys.length === 0) return 0
  const time = Math.max(0, Math.min(1, Number(t) || 0))
  if (time <= keys[0][0]) return keys[0][1]
  if (time >= keys[keys.length - 1][0]) return keys[keys.length - 1][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]
    if (time <= t1) {
      const [t0, v0] = keys[i - 1]
      const span = t1 - t0
      const k = span <= 1e-9 ? 1 : (time - t0) / span
      // smoothstep：比线性自然得多，而且不用引入缓动曲线表
      const eased = k * k * (3 - 2 * k)
      return v0 + (v1 - v0) * eased
    }
  }
  return keys[keys.length - 1][1]
}

/**
 * 动作库。
 *
 * 字段说明：
 *   id       动作 id
 *   label    中文名
 *   aliases  触发词（中英混写，匹配时按长度优先 —— "举枪射击"要命中而不是命中"射击"）
 *   duration 默认时长（秒）
 *   loop     是否循环
 *   channels 关键帧；rotation 单位度（正=顺时针），x/y 单位像素（相对枢轴）
 *   note     这个动作的意图/适用场景（给 AI 看的，帮它选对）
 */
export const MOTIONS = [
  {
    id: 'idle',
    label: '待机',
    aliases: ['待机', '站立', '静止', '呼吸', 'idle', 'stand', 'breath', 'breathe'],
    duration: 2.4,
    loop: true,
    note: '站着不动但有呼吸感。任何角色的默认动作。',
    channels: {
      torso: { rotation: [[0, 0], [0.5, -1.6], [1, 0]] },
      head: { rotation: [[0, 0], [0.5, 1.2], [1, 0]] },
      upper_arm_L: { rotation: [[0, 2], [0.5, 4], [1, 2]] },
      upper_arm_R: { rotation: [[0, -2], [0.5, -4], [1, -2]] },
      hip: { y: [[0, 0], [0.5, -1.5], [1, 0]] },
    },
  },
  {
    id: 'walk',
    label: '走动',
    aliases: ['走动', '走路', '行走', '步行', 'walk', 'walking', 'stroll'],
    excludes: ['走马观花', '走神', '走私'],
    duration: 0.9,
    loop: true,
    note: '双腿交替迈步 + 手臂反向摆。两个关键帧相位差 0.5。',
    channels: {
      thigh_L: { rotation: [[0, 24], [0.5, -24], [1, 24]] },
      thigh_R: { rotation: [[0, -24], [0.5, 24], [1, -24]] },
      shin_L: { rotation: [[0, -8], [0.25, -26], [0.5, -6], [0.75, -4], [1, -8]] },
      shin_R: { rotation: [[0, -6], [0.25, -4], [0.5, -8], [0.75, -26], [1, -6]] },
      upper_arm_L: { rotation: [[0, -18], [0.5, 18], [1, -18]] },
      upper_arm_R: { rotation: [[0, 18], [0.5, -18], [1, 18]] },
      forearm_L: { rotation: [[0, 8], [0.5, 20], [1, 8]] },
      forearm_R: { rotation: [[0, 20], [0.5, 8], [1, 20]] },
      // 走路时身体上下起伏：两个循环（每步一次）
      hip: { y: [[0, 0], [0.25, -3], [0.5, 0], [0.75, -3], [1, 0]] },
      torso: { rotation: [[0, 2], [0.5, -2], [1, 2]] },
    },
  },
  {
    id: 'run',
    label: '奔跑',
    aliases: ['奔跑', '跑步', '冲刺', '跑', 'run', 'running', 'sprint', 'dash'],
    duration: 0.55,
    loop: true,
    note: '比走动幅度大、频率快、身体前倾。',
    channels: {
      thigh_L: { rotation: [[0, 46], [0.5, -34], [1, 46]] },
      thigh_R: { rotation: [[0, -34], [0.5, 46], [1, -34]] },
      shin_L: { rotation: [[0, -24], [0.3, -70], [0.6, -20], [1, -24]] },
      shin_R: { rotation: [[0, -20], [0.3, -70], [0.6, -24], [1, -20]] },
      upper_arm_L: { rotation: [[0, -46], [0.5, 40], [1, -46]] },
      upper_arm_R: { rotation: [[0, 40], [0.5, -46], [1, 40]] },
      forearm_L: { rotation: [[0, 55], [0.5, 78], [1, 55]] },
      forearm_R: { rotation: [[0, 78], [0.5, 55], [1, 78]] },
      torso: { rotation: [[0, 8], [0.5, 5], [1, 8]] },
      head: { rotation: [[0, -6], [0.5, -4], [1, -6]] },
      hip: { y: [[0, 0], [0.25, -7], [0.5, 0], [0.75, -7], [1, 0]] },
    },
  },
  {
    id: 'aim',
    label: '举枪瞄准',
    aliases: ['举枪', '瞄准', '端枪', '抬枪', '举枪瞄准', 'aim', 'aiming', 'raise gun'],
    duration: 0.35,
    loop: false,
    note: '双臂抬到水平、身体微侧，停在瞄准姿势。常和 fire 连用。',
    channels: {
      upper_arm_L: { rotation: [[0, 2], [1, -72]] },
      upper_arm_R: { rotation: [[0, -2], [1, 68]] },
      forearm_L: { rotation: [[0, 8], [1, 22]] },
      forearm_R: { rotation: [[0, 8], [1, -16]] },
      torso: { rotation: [[0, 0], [1, -6]] },
      head: { rotation: [[0, 0], [1, 4]] },
    },
  },
  {
    id: 'fire',
    label: '开火',
    aliases: ['开火', '射击', '开枪', '发射', '攻击', 'fire', 'shoot', 'shot', 'attack ranged'],
    // 注：「举枪攻击」这类**完整**动作归 aim_fire（组合动作）。
    // 让 fire 也认这几个词会平票，然后"单帧扣扳机"可能抢走"三段动作" —— 用户要的是后者。
    duration: 0.32,
    loop: false,
    note: '开一枪：先抬臂到瞄准位，中段后坐力上跳，最后回位。单发用这个；连发就把 speed 调快重复播。',
    channels: {
      upper_arm_L: { rotation: [[0, -72], [0.18, -80], [0.45, -68], [1, -72]] },
      upper_arm_R: { rotation: [[0, 68], [0.18, 76], [0.45, 64], [1, 68]] },
      forearm_L: { rotation: [[0, 22], [0.18, 34], [1, 22]] },
      forearm_R: { rotation: [[0, -16], [0.18, -26], [1, -16]] },
      // 后坐力：躯干与头部往后一顿
      torso: { rotation: [[0, -6], [0.18, -11], [0.5, -4], [1, -6]] },
      head: { rotation: [[0, 4], [0.18, 9], [0.5, 3], [1, 4]] },
      hip: { x: [[0, 0], [0.18, -3], [1, 0]] },
    },
  },
  {
    id: 'slash',
    label: '挥砍',
    aliases: ['挥砍', '劈砍', '挥剑', '砍', '近战', '挥刀', 'slash', 'swing', 'melee', 'chop'],
    duration: 0.42,
    loop: false,
    note: '近战横劈：抬手蓄力 → 快速挥下 → 收势。',
    channels: {
      upper_arm_R: { rotation: [[0, 10], [0.3, -102], [0.55, 46], [1, 10]] },
      forearm_R: { rotation: [[0, 10], [0.3, -30], [0.55, 18], [1, 10]] },
      torso: { rotation: [[0, 0], [0.3, -12], [0.55, 14], [1, 0]] },
      head: { rotation: [[0, 0], [0.3, 6], [0.55, -6], [1, 0]] },
      upper_arm_L: { rotation: [[0, 0], [0.3, 18], [1, 0]] },
      hip: { x: [[0, 0], [0.3, -3], [0.55, 4], [1, 0]] },
    },
  },
  {
    id: 'throw',
    label: '投掷',
    aliases: ['投掷', '扔', '抛', '扔手雷', 'throw', 'toss', 'grenade'],
    duration: 0.5,
    loop: false,
    note: '侧身蓄力然后甩出。',
    channels: {
      upper_arm_R: { rotation: [[0, 0], [0.35, 120], [0.6, -40], [1, 0]] },
      forearm_R: { rotation: [[0, 0], [0.35, 60], [0.6, -10], [1, 0]] },
      torso: { rotation: [[0, 0], [0.35, 16], [0.6, -14], [1, 0]] },
      upper_arm_L: { rotation: [[0, 0], [0.35, -20], [1, 0]] },
      hip: { x: [[0, 0], [0.6, 4], [1, 0]] },
    },
  },
  {
    id: 'hit',
    label: '受击',
    aliases: ['受击', '被击', '受伤', '挨打', '中弹', 'hit', 'hurt', 'damaged', 'take damage'],
    duration: 0.28,
    loop: false,
    note: '身体后仰一顿然后回位。适合被打时的短反馈。',
    channels: {
      torso: { rotation: [[0, 0], [0.25, 12], [1, 0]] },
      head: { rotation: [[0, 0], [0.25, 16], [1, 0]] },
      upper_arm_L: { rotation: [[0, 0], [0.25, 26], [1, 0]] },
      upper_arm_R: { rotation: [[0, 0], [0.25, -22], [1, 0]] },
      hip: { x: [[0, 0], [0.25, -5], [1, 0]] },
    },
  },
  {
    id: 'die',
    label: '死亡',
    aliases: ['死亡', '倒下', '阵亡', '死', 'die', 'death', 'dead', 'collapse'],
    excludes: ['死机', '死锁', '死角'],
    duration: 0.9,
    loop: false,
    note: '向后倒地，不回到初始姿势（播完停在最后姿态）。',
    channels: {
      hip: { rotation: [[0, 0], [1, -78]], y: [[0, 0], [0.6, -10], [1, -22]] },
      torso: { rotation: [[0, 0], [1, 16]] },
      head: { rotation: [[0, 0], [1, 26]] },
      upper_arm_L: { rotation: [[0, 0], [1, 62]] },
      upper_arm_R: { rotation: [[0, 0], [1, -58]] },
      thigh_L: { rotation: [[0, 0], [1, 30]] },
      thigh_R: { rotation: [[0, 0], [1, -18]] },
    },
  },
  {
    id: 'jump',
    label: '跳跃',
    aliases: ['跳跃', '跳', '起跳', 'jump', 'leap', 'hop'],
    // 「跳」是单字别名，必然会被「跳舞/跳绳」误命中 —— 这类别名必须配排除表
    excludes: ['跳舞', '跳绳', '跳蚤', '跳槽', '跳票'],
    duration: 0.6,
    loop: false,
    note: '下蹲蓄力 → 起跳伸展 → 落地缓冲。',
    channels: {
      hip: { y: [[0, 0], [0.2, 8], [0.5, -26], [0.8, 6], [1, 0]] },
      thigh_L: { rotation: [[0, 0], [0.2, 26], [0.5, -18], [1, 0]] },
      thigh_R: { rotation: [[0, 0], [0.2, 26], [0.5, -18], [1, 0]] },
      shin_L: { rotation: [[0, 0], [0.2, -46], [0.5, 6], [1, 0]] },
      shin_R: { rotation: [[0, 0], [0.2, -46], [0.5, 6], [1, 0]] },
      upper_arm_L: { rotation: [[0, 0], [0.2, -30], [0.5, 54], [1, 0]] },
      upper_arm_R: { rotation: [[0, 0], [0.2, 30], [0.5, -54], [1, 0]] },
    },
  },
  {
    id: 'wave',
    label: '挥手',
    aliases: ['挥手', '招手', '打招呼', '挥', 'wave', 'greet', 'hello'],
    excludes: ['挥发', '挥霍', '指挥'],
    duration: 1.1,
    loop: false,
    note: '抬手挥两下，打招呼用。',
    channels: {
      upper_arm_R: { rotation: [[0, 0], [0.2, -128], [1, -128]] },
      forearm_R: { rotation: [[0, 0], [0.2, -20], [0.45, 18], [0.7, -20], [0.9, 10], [1, -20]] },
      head: { rotation: [[0, 0], [0.2, -4], [1, -4]] },
    },
  },
  /* ── 组合动作：把下面几段串起来 ──
   * 为什么需要它：「举枪攻击」不是"开火"那 0.32 秒 —— 真实动作是
   * **抬枪瞄准 → 开火后坐 → 收枪**。只播 fire 会变成"手已经举着凭空抖一下"。
   * 串起来的成本很低（就是把时间轴拼接），效果差很多。 */
  {
    id: 'aim_fire',
    label: '举枪攻击',
    aliases: ['举枪攻击', '举枪射击', '瞄准射击', '端枪射击', 'aim and fire', 'aimed shot', 'aim fire'],
    duration: 1.0,
    loop: false,
    sequence: ['aim', 'fire', 'aim'],
    note: '抬枪瞄准 → 开火（后坐）→ 收枪。这是射击类攻击最常用的完整动作。',
    channels: {},
  },
  {
    id: 'crouch',
    label: '蹲下',
    aliases: ['蹲下', '蹲', '下蹲', 'crouch', 'duck', 'sneak'],
    duration: 0.4,
    loop: false,
    note: '屈膝压低重心，保持蹲姿（不回到站立）。',
    channels: {
      hip: { y: [[0, 0], [1, 22]] },
      thigh_L: { rotation: [[0, 0], [1, 62]] },
      thigh_R: { rotation: [[0, 0], [1, 62]] },
      shin_L: { rotation: [[0, 0], [1, -96]] },
      shin_R: { rotation: [[0, 0], [1, -96]] },
      torso: { rotation: [[0, 0], [1, 10]] },
    },
  },

  /* ══════════════════════════════════════════════════════════════════════
   * 正俯视（从头顶往下看）动作组 —— view: 'top'
   * ----------------------------------------------------------------------
   * 关键差异：**腿被身体完全挡住，看不见**。
   * 所以「走路」不能靠迈腿，只能靠：身体上下起伏 + 肩膀左右微摆 + 胳膊轻晃。
   * 这是俯视 2D 游戏（twin-stick / RTS）里表现"在走"的常规做法 ——
   * 如果照搬前视的迈腿动作，玩家看到的是一个原地滑动的躯干，非常出戏。
   *
   * 方位约定：画面向上 = 角色前方。所以正角度旋转 = 顺时针（向右偏）。
   * 胳膊/枪的枢轴在下端（肩/肘/握把），绕它转就是"抬枪/收枪"。
   * ══════════════════════════════════════════════════════════════════════ */
  {
    id: 'idle_td',
    label: '俯视待机',
    view: 'top',
    aliases: ['俯视待机', '站立待机', '呼吸', 'idle_td', 'topdown idle'],
    duration: 2.2,
    loop: true,
    note: '站着但身体有极轻的呼吸起伏。俯视默认动作。',
    channels: {
      body: { rotation: [[0, 0], [0.5, -1.2], [1, 0]], y: [[0, 0], [0.5, -1], [1, 0]] },
      head: { rotation: [[0, 0], [0.5, 0.9], [1, 0]] },
      upper_arm_L: { rotation: [[0, 0], [0.5, 1.6], [1, 0]] },
      upper_arm_R: { rotation: [[0, 0], [0.5, -1.6], [1, 0]] },
    },
  },
  {
    id: 'walk_td',
    label: '俯视走动',
    view: 'top',
    aliases: ['俯视走动', '俯视走路', 'walk_td', 'topdown walk'],
    duration: 0.85,
    loop: true,
    note: '腿看不见，所以靠身体起伏 + 肩膀左右摆 + 胳膊晃来表现"在走"。',
    channels: {
      // 身体每步下沉一次 → 一个周期两次起伏；同时肩膀左右摆（走路时上半身会转）
      body: {
        y: [[0, 0], [0.25, -2.2], [0.5, 0], [0.75, -2.2], [1, 0]],
        rotation: [[0, -2], [0.5, 2], [1, -2]],
      },
      upper_arm_L: { rotation: [[0, -3], [0.5, 4], [1, -3]] },
      upper_arm_R: { rotation: [[0, 4], [0.5, -3], [1, 4]] },
      forearm_L: { rotation: [[0, 2], [0.5, -2], [1, 2]] },
      forearm_R: { rotation: [[0, -2], [0.5, 2], [1, -2]] },
      rifle: { rotation: [[0, 1.5], [0.5, -1.5], [1, 1.5]] },
      head: { rotation: [[0, 1], [0.5, -1], [1, 1]] },
    },
  },
  {
    id: 'run_td',
    label: '俯视奔跑',
    view: 'top',
    aliases: ['俯视奔跑', '俯视跑', 'run_td', 'topdown run', 'topdown sprint'],
    duration: 0.5,
    loop: true,
    note: '比走更快、起伏更大、枪口上下颠得更明显。',
    channels: {
      body: { y: [[0, 0], [0.25, -5], [0.5, 0], [0.75, -5], [1, 0]], rotation: [[0, 1.5], [0.5, -1.5], [1, 1.5]] },
      upper_arm_L: { rotation: [[0, -7], [0.5, 9], [1, -7]] },
      upper_arm_R: { rotation: [[0, 9], [0.5, -7], [1, 9]] },
      forearm_L: { rotation: [[0, 4], [0.5, -5], [1, 4]] },
      forearm_R: { rotation: [[0, -5], [0.5, 4], [1, -5]] },
      rifle: { rotation: [[0, 4], [0.5, -4], [1, 4]], y: [[0, 0], [0.25, -2], [0.5, 0], [0.75, -2], [1, 0]] },
      head: { rotation: [[0, 2], [0.5, -2], [1, 2]] },
    },
  },
  {
    id: 'aim_td',
    label: '俯视举枪瞄准',
    view: 'top',
    aliases: ['俯视瞄准', '俯视举枪', 'aim_td', 'topdown aim'],
    duration: 0.3,
    loop: false,
    note: '双臂带枪抬到正前方，停在瞄准位（枪口沿身体中轴朝前）。',
    channels: {
      upper_arm_L: { rotation: [[0, 6], [1, -4]] },
      upper_arm_R: { rotation: [[0, -6], [1, 4]] },
      forearm_L: { rotation: [[0, 4], [1, -2]] },
      forearm_R: { rotation: [[0, -4], [1, 2]] },
      rifle: { rotation: [[0, 0], [1, 0]], y: [[0, 0], [1, -3]] },
      head: { rotation: [[0, 0], [1, 1]] },
    },
  },
  {
    id: 'fire_td',
    label: '俯视开火',
    view: 'top',
    aliases: ['俯视开火', '俯视射击', '俯视开一枪', 'fire_td', 'topdown fire', 'topdown shoot'],
    duration: 0.26,
    loop: false,
    note: '枪与双臂一起向后一顿（后坐），然后回位。连发就把 speed 调快重复播。',
    channels: {
      // 后坐：枪整体向后（y 正 = 屏幕向下 = 角色后方）
      rifle: { y: [[0, 0], [0.15, 4], [0.45, -1], [1, 0]], rotation: [[0, 0], [0.15, -5], [0.45, 2], [1, 0]] },
      upper_arm_R: { rotation: [[0, 4], [0.15, 11], [0.45, 1], [1, 4]] },
      upper_arm_L: { rotation: [[0, -4], [0.15, -10], [0.45, -2], [1, -4]] },
      forearm_R: { rotation: [[0, 2], [0.15, 7], [1, 2]] },
      forearm_L: { rotation: [[0, -2], [0.15, -6], [1, -2]] },
      // 身体被后坐力顶得往后一点
      body: { y: [[0, 0], [0.15, 2], [0.5, 0], [1, 0]] },
      head: { rotation: [[0, 0], [0.15, -3], [1, 0]] },
    },
  },
  {
    id: 'reload_td',
    label: '俯视装填',
    view: 'top',
    aliases: ['俯视装填', '俯视换弹', '换弹匣', 'reload_td', 'topdown reload'],
    duration: 1.5,
    loop: false,
    note: '枪口下压、左臂伸向弹匣位，停顿一下再抬回。',
    channels: {
      rifle: { rotation: [[0, 0], [0.25, 14], [0.7, 14], [1, 0]], y: [[0, 0], [0.25, 3], [0.7, 3], [1, 0]] },
      upper_arm_L: { rotation: [[0, -4], [0.3, -26], [0.7, -22], [1, -4]] },
      forearm_L: { rotation: [[0, 0], [0.3, 20], [0.55, -14], [0.8, 12], [1, 0]] },
      upper_arm_R: { rotation: [[0, 4], [0.3, 10], [0.7, 9], [1, 4]] },
      body: { rotation: [[0, 0], [0.3, 3], [0.7, 3], [1, 0]] },
      head: { rotation: [[0, 0], [0.3, 6], [0.7, 6], [1, 0]] },
    },
  },
  {
    id: 'hit_td',
    label: '俯视受击',
    view: 'top',
    aliases: ['俯视受击', '俯视中弹', 'hit_td', 'topdown hit'],
    duration: 0.24,
    loop: false,
    note: '整个身体被推得后仰一下，枪也跟着歪。',
    channels: {
      body: { y: [[0, 0], [0.25, 3], [1, 0]], rotation: [[0, 0], [0.25, -6], [1, 0]] },
      head: { rotation: [[0, 0], [0.25, -8], [1, 0]] },
      rifle: { rotation: [[0, 0], [0.25, 8], [1, 0]] },
      upper_arm_L: { rotation: [[0, 0], [0.25, 10], [1, 0]] },
      upper_arm_R: { rotation: [[0, 0], [0.25, -10], [1, 0]] },
    },
  },
  {
    id: 'die_td',
    label: '俯视死亡',
    view: 'top',
    aliases: ['俯视死亡', '俯视倒下', 'die_td', 'topdown die'],
    duration: 0.8,
    loop: false,
    note: '整个人横倒下去（俯视看就是原地转倒），枪脱手偏出去。',
    channels: {
      body: { rotation: [[0, 0], [1, 78]], y: [[0, 0], [1, 4]] },
      head: { rotation: [[0, 0], [1, 20]] },
      upper_arm_L: { rotation: [[0, 0], [1, -46]] },
      upper_arm_R: { rotation: [[0, 0], [1, 38]] },
      rifle: { rotation: [[0, 0], [1, 26]], y: [[0, 0], [1, 6]] },
    },
  },
]

const MOTION_BY_ID = new Map(MOTIONS.map((m) => [m.id, m]))

export function listMotions() {
  return MOTIONS.map((m) => ({
    id: m.id, label: m.label, aliases: m.aliases, excludes: m.excludes ?? [], duration: m.duration, loop: m.loop,
    bones: Object.keys(m.channels), note: m.note,
  }))
}

export function getMotion(id) {
  return MOTION_BY_ID.get(String(id ?? '').toLowerCase()) ?? null
}

/**
 * 自然语言 → 动作。
 *
 * 打分规则（有意做得很朴素，因为它要**可预测**）：
 *   - 别名整串命中 → 分高，且**越长的别名分越高**（"举枪射击"要赢过"射击"）
 *   - 只命中 id 本身 → 中等分
 *   - 命中多个动作 → 返回排序后的候选，让人/AI 看到它其实没把握
 *
 * 为什么不做模糊语义匹配：那需要模型，而这里的目标恰恰是**不依赖模型也可靠**。
 * 匹配不上的时候返回 candidates 并让人选，比硬猜一个动作好。
 *
 * @returns {{ok:boolean, id:string|null, motion:object|null, score:number, matched:string,
 *            candidates:Array<{id,label,score,matched}>, text:string}}
 */
export function matchMotion(text, { minScore = 1 } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, id: null, motion: null, score: 0, matched: '', candidates: [], text: raw, error: '没给动作描述' }
  const lower = raw.toLowerCase()
  const scored = []
  for (const motion of MOTIONS) {
    let best = 0
    let matched = ''
    for (const alias of motion.aliases) {
      const needle = String(alias).toLowerCase()
      if (!needle) continue
      if (!lower.includes(needle)) continue
      // 排除词：单字别名必须靠这个挡住「跳舞/挥发/死机」这类同字不同义的词
      if (Array.isArray(motion.excludes) && motion.excludes.some((word) => lower.includes(String(word).toLowerCase()))) continue
      // 长度权重：3 字以上的别名给更高权重（"举枪攻击" vs "攻击"）
      const score = needle.length >= 4 ? 3 : needle.length >= 2 ? 2 : 1
      if (score > best) { best = score; matched = alias }
    }
    if (lower.includes(motion.id) && best === 0) { best = 1; matched = motion.id }
    if (best > 0) scored.push({ id: motion.id, label: motion.label, score: best, matched })
  }
  /* 平票规则：分高优先 → **组合动作优先** → 别名长的优先。
   * 为什么中间那条重要："举枪攻击"会同时命中 fire 和 aim_fire 的别名，
   * 这时应该给完整的三段动作（抬枪→开火→收枪），而不是单帧的扣扳机。 */
  const isSequence = (id) => Boolean(MOTION_BY_ID.get(id)?.sequence)
  scored.sort((a, b) => (b.score - a.score)
    || (Number(isSequence(b.id)) - Number(isSequence(a.id)))
    || (b.matched.length - a.matched.length))
  const top = scored[0] ?? null
  if (!top || top.score < minScore) {
    return {
      ok: false, id: null, motion: null, score: 0, matched: '', text: raw,
      candidates: scored.slice(0, 5),
      error: `没匹配到动作：「${raw}」。可用动作：${MOTIONS.map((m) => m.label).join('、')}`,
    }
  }
  return {
    ok: true,
    id: top.id,
    motion: MOTION_BY_ID.get(top.id) ?? null,
    score: top.score,
    matched: top.matched,
    candidates: scored.slice(0, 5),
    text: raw,
    ambiguous: scored.length > 1 && scored[1].score === top.score,
  }
}

/**
 * 把多段动画按顺序拼成一段（时间轴拼接）。
 * 为什么需要：组合动作（举枪攻击 = 瞄准 → 开火 → 收枪）不能只取其中一段，
 * 否则看起来是"手已经举着凭空抖一下"。拼接只要把每段的 t 重映射到整段的时间轴上。
 *
 * @param {Array<{duration:number, channels:object}>} parts
 * @returns {{duration:number, channels:object}}
 */
export function mergeAnimations(parts) {
  const list = (parts ?? []).filter((p) => p && p.channels && Object.keys(p.channels).length > 0)
  if (list.length === 0) return { duration: 1, channels: {} }
  const total = list.reduce((sum, p) => sum + (Number(p.duration) || 1), 0)
  const channels = {}
  let offset = 0
  for (const part of list) {
    const dur = Number(part.duration) || 1
    const span = dur / total
    for (const [boneName, channel] of Object.entries(part.channels)) {
      const target = (channels[boneName] ??= {})
      for (const [prop, keys] of Object.entries(channel)) {
        const remapped = keys.map(([t, v]) => [Number((offset + t * span).toFixed(4)), v])
        // 拼接处去重：上一段的末帧和下一段的首帧时间几乎重合时，保留后一段的（避免零点几度的抖动）
        if (target[prop] && remapped.length > 0) {
          const lastT = target[prop][target[prop].length - 1][0]
          if (Math.abs(remapped[0][0] - lastT) < 1e-6) remapped.shift()
        }
        target[prop] = [...(target[prop] ?? []), ...remapped]
      }
    }
    offset += span
  }
  return { duration: Number(total.toFixed(3)), channels }
}

/**
 * 把动作展开成 skeleton.animations 里的一条。
 *
 * @param {object} params
 * @param {object} params.skeleton 现有骨架（用来确认哪些骨骼真的有）
 * @param {string} params.motionId 动作 id（也可以直接传人话，会自动 matchMotion）
 * @param {number} [params.speed] 速度倍率（> 1 更快，时长变短）
 * @param {number} [params.amplitude] 幅度倍率（旋转/位移按比例缩放）
 * @param {boolean} [params.mirror] 镜像（左右互换，做"另一只手挥"用）
 * @param {string} [params.name] 动画名（默认用动作 id）
 * @returns {{ok:boolean, name:string, animation:object|null, missingBones:string[], error?:string}}
 */
export function buildAnimation({
  skeleton,
  motionId,
  speed = 1,
  amplitude = 1,
  mirror = false,
  name = '',
} = {}) {
  let motion = getMotion(motionId)
  if (!motion) {
    const matched = matchMotion(motionId)
    if (!matched.ok) return { ok: false, error: matched.error, candidates: matched.candidates, animation: null, name: '' }
    motion = matched.motion
  }
  const bones = new Set((skeleton?.bones ?? []).map((b) => b.name))
  if (bones.size === 0) return { ok: false, error: '骨架里没有骨骼', animation: null, name: '' }

  // 组合动作：先把各段展开，再拼起来
  let source = motion
  if (Array.isArray(motion.sequence) && motion.sequence.length > 0) {
    const parts = []
    const missingSteps = []
    for (const stepId of motion.sequence) {
      const step = getMotion(stepId)
      if (!step || !step.channels || Object.keys(step.channels).length === 0) { missingSteps.push(stepId); continue }
      parts.push({ duration: step.duration, channels: step.channels })
    }
    if (parts.length === 0) {
      return { ok: false, error: `组合动作 ${motion.id} 的子动作都没找到（${motion.sequence.join('、')}）`, animation: null, name: '' }
    }
    const merged = mergeAnimations(parts)
    source = { ...motion, channels: merged.channels, duration: motion.duration || merged.duration }
  }

  const swap = (boneName) => {
    if (!mirror) return boneName
    if (boneName.endsWith('_L')) return `${boneName.slice(0, -2)}_R`
    if (boneName.endsWith('_R')) return `${boneName.slice(0, -2)}_L`
    return boneName
  }

  const channels = {}
  const missingBones = []
  for (const [boneName, channel] of Object.entries(source.channels ?? {})) {
    const target = swap(boneName)
    if (!bones.has(target)) { missingBones.push(target); continue }
    const out = {}
    for (const [prop, keys] of Object.entries(channel)) {
      // 镜像时旋转要反向（左手抬和右手抬方向相反）
      const sign = mirror && prop === 'rotation' ? -1 : 1
      out[prop] = keys.map(([t, v]) => [t, Number((v * amplitude * sign).toFixed(3))])
    }
    channels[target] = out
  }
  if (Object.keys(channels).length === 0) {
    return { ok: false, error: `这个动作要的骨骼骨架里一个都没有（缺：${missingBones.join('、')}）`, animation: null, name: '' }
  }

  const animationName = name || motion.id
  const duration = Math.max(0.05, Number((Number(source.duration || motion.duration) / Math.max(0.05, Number(speed) || 1)).toFixed(3)))
  return {
    ok: true,
    name: animationName,
    animation: {
      motion: motion.id,
      label: motion.label,
      duration,
      loop: Boolean(motion.loop),
      channels,
      note: motion.note,
      ...(motion.sequence ? { sequence: motion.sequence } : {}),
    },
    missingBones,
    ...(missingBones.length > 0 ? { warning: `骨架里没有：${missingBones.join('、')}（这些通道已跳过）` } : {}),
  }
}

/**
 * 采样某一时刻的 pose（喂给 worldTransforms）。
 *
 * 签名故意只收 (animation, time) —— 不需要 skeleton：
 * 通道里写的骨骼名直接对应骨架骨骼，多余的会被 worldTransforms 忽略。
 * （早先留了个 skeleton 形参但根本没用，正是那种"等着被误用"的签名。）
 *
 * @returns {object} { 骨骼名: { rotation?, x?, y? } }
 */
export function sampleAnimation(animation, time) {
  if (!animation?.channels) return {}
  const duration = Math.max(0.001, Number(animation.duration) || 1)
  let t = Number(time) / duration
  if (animation.loop) {
    t = t % 1
    if (t < 0) t += 1
  } else {
    t = Math.max(0, Math.min(1, t))
  }
  const pose = {}
  for (const [boneName, channel] of Object.entries(animation.channels)) {
    const entry = {}
    for (const [prop, keys] of Object.entries(channel)) entry[prop] = sampleChannel(keys, t)
    pose[boneName] = entry
  }
  return pose
}

/** 按名字从 skeleton.animations 里取一条并采样。 */
export function sampleNamedAnimation(skeleton, name, time) {
  const animation = skeleton?.animations?.[name]
  if (!animation) return null
  return sampleAnimation(animation, time)
}

/** 从一段人话里猜动画名 + 参数（速度）："快速奔跑" → run + speed 1.4。 */
export function interpretMotionRequest(text) {
  const raw = String(text ?? '')
  const matched = matchMotion(raw)
  const speedHints = [
    { re: /(快速|迅速|飞快|加快|fast|quick|rapid)/i, speed: 1.5 },
    { re: /(慢速|缓慢|慢慢|慢动作|slow)/i, speed: 0.6 },
  ]
  let speed = 1
  for (const hint of speedHints) if (hint.re.test(raw)) { speed = hint.speed; break }
  const amplitude = /(夸张|大幅|用力|重|strong|big|exaggerat)/i.test(raw) ? 1.35
    : /(轻微|小幅|轻轻|soft|slight|subtle)/i.test(raw) ? 0.7
      : 1
  const mirror = /(左手|左臂|另一只手|left hand|other hand)/i.test(raw)
  const loopHint = /(循环|重复|loop|repeat)/i.test(raw)
  return {
    ...matched,
    params: { speed, amplitude, mirror, ...(loopHint ? { forceLoop: true } : {}) },
    interpreted: matched.ok
      ? { 动作: matched.motion.label, 速度: speed, 幅度: amplitude, 镜像: mirror }
      : null,
  }
}

/** 镜像一个动作（不重算，直接对调左右通道并反转旋转）——给"另一只手挥"这种需求用。 */
export function mirrorAnimation(animation) {
  if (!animation?.channels) return null
  const channels = {}
  for (const [boneName, channel] of Object.entries(animation.channels)) {
    const target = boneName.endsWith('_L') ? `${boneName.slice(0, -2)}_R`
      : boneName.endsWith('_R') ? `${boneName.slice(0, -2)}_L` : boneName
    const out = {}
    for (const [prop, keys] of Object.entries(channel)) {
      const sign = prop === 'rotation' ? -1 : 1
      out[prop] = keys.map(([t, v]) => [t, v * sign])
    }
    channels[target] = out
  }
  return { ...animation, channels, mirrored: !animation.mirrored }
}

/** 人形骨架的骨骼名单（给"这个动作需要哪些骨骼"的说明用）。 */
export function humanoidBoneNames() {
  return HUMANOID_SLOTS.map((s) => s.name)
}
