# dsh-taskboard 产品化 Review（第一性原理 + 全网对标）

> 目标：将该插件产品化为「真正与 agent 协作、且任务自带度量」的任务板。
> 方法：从协作本质拆解当前 21 项功能 → 与 [agent-board](https://github.com/quentintou/agent-board)
> （OpenClaw 多 agent 任务板，最接近的竞品）及 kanban 度量标准逐项对标 → 判定
> 增强/保持/鸡肋/删除 → 给出度量设计与路线图。

---

## 一、第一性原理：这个看板到底回答什么

把「人-机协作」拆到最底，任务板只需要回答四个问题，其余都是手段：

| # | 问题 | 现状 | 判定 |
|---|---|---|---|
| Q1 | **现在该谁动？**（球在谁手） | 七态状态机 + 等人列警示 + auto-claim | ✅ 已解决 |
| Q2 | **要做什么、做到什么算完？** | spec 门（acceptance criteria 强制）+ context_refs + definition_of_done | ✅ 已解决，且强于竞品 |
| Q3 | **证据在哪？** | 结构化证据（逐 criterion met/note + artifacts + summary） | ✅ 差异化护城河 |
| Q4 | **花了多少时间/代价？** | ❌ **缺失** | 🚨 核心缺口 |

**Q4 就是用户点名的「度量」**。好消息：Q4 的地基（活动流全量记录每次状态转换的
from/to/at）从 v0.2 起就在，**零采集成本**即可推导一切时间度量——这是本产品比
绝大多数竞品更接近「自带度量」的原因，只差一层计算与呈现。

---

## 二、外部坐标：与 agent-board 的逐项对标

agent-board（OpenClaw 生态、MCP 原生、`backlog→todo→doing→review→done→failed`
六列）是本产品最接近的竞品，差异即机会：

| 能力 | agent-board | 本产品 | 判定 |
|---|---|---|---|
| 看板 | 6 列 | 7 列状态机 | 平 |
| 完成定义 | `requiresReview` 布尔门 | **结构化验收标准 + 逐条证据** | ✅ 我们更强 |
| 依赖 | DAG + 环检测 | DAG + 环检测（v0.7） | 平 |
| **失败处理** | **auto-retry 到 maxRetries** | **bounce 打回 + human 确认（默认人审）** | ⚠️ 缺 auto-retry 配置 |
| **任务链** | **nextTask 完成即自动创建下一个** | 只有 dependsOn（阻塞） | ⚠️ 缺 chaining |
| **agent 间通信** | **任务评论线程 + 签名 webhook 唤醒** | notes 是 append-only，且**对执行 agent 不可见** | 🚨 缺 |
| 审计 | audit.jsonl | 活动流（结构化 from/to/at） | ✅ 我们更强 |
| **统计** | **Board Stats：完成率/平均时长/stuck 检测** | 只有即时统计条（E2） | 🚨 缺趋势度量 |
| 模板 | 项目模板 JSON | 无 | ⚪ 可选 |
| 客户端视图 | 只读 stakeholder 面板 | 无 | ⚪ 可选 |
| 并发安全 | 文件互斥锁 | 写前守卫（检测非预防） | ⚪ 各有所长 |
| 外部协议 | MCP + REST + API Key | ctx.tools + REST（dsh 原生） | ⚪ 生态差异 |

**结论**：我们在「定义—证据—人审」这条质量主线上全面领先；竞品在「自动化循环」
（auto-retry / chaining / agent 通信）与「统计」上领先。产品化的方向非常清晰：
**守住质量主线，补齐自动化循环，把统计做成度量。**

---

## 三、逐功能判定

### ✅ 增强（产品化主线）

| 功能 | 为什么增强 | 方向 |
|---|---|---|
| **度量层（新）** | Q4 缺失；活动流数据已在 | `/stats` 端点 + 面板趋势（见第四节） |
| **notes 对 agent 可见** | 现在人的指示（打回原因、过程备注）执行 agent 永远看不到——协作断了 | 派发 prompt 注入 notes；bounce 原因自动进入上下文 |
| **失败策略可配置** | 竞品 auto-retry，我们纯人审；两种都对，应可配 | `autoRetry` 任务级/全局配置，失败自动回到 open（限次），bounce 仍走人审 |
| **证据产物可点** | artifacts 现在是纯文本路径 | 识别文件/commit 链接，面板可点开 |
| **实际 token 用量落库** | 有预算（budget/context）但从不记录实际消耗 | settle 时从 run 记录实际用量 → 预算效率度量 |
| **经验卡片闭环** | relatedExperience 只在 create 时注入，打回重做时没有 | 打回时自动关联「上次怎么失败的」 |

### ⚪ 保持（必要或已够用）

| 功能 | 说明 |
|---|---|
| spec 门 / 证据 / 打回带原因 | 质量主线，继续是差异化 |
| auto-claim / 预算 / 依赖 / 状态机 | 协作核心，已稳 |
| 归档 / 恢复 / 归档全部 | 治理低频但必要 |
| 编辑/新建弹窗、统计条、活动抽屉 | 基础体验，刚迭代完 |
| export/import、C2 守卫、workspace 绑定、短 id | 工程/生态底座 |

### ⚠️ 鸡肋（当前价值低于维护成本——重点）

| 功能 | 为什么鸡肋 | 处置 |
|---|---|---|
| **E1 项目过滤** | **项目根本创建不了**（无建项目入口，只有种子 Inbox），过滤等于空操作 | **修**：补项目生命周期（建/改名/迁移），或**删** |
| **/task 只读命令** | 面板更直观，只读命令无人用 | **补写命令**（gate 已支持 human initiator）或**删** |
| **E3 拖拽排序** | 只服务「人的视觉优先级」，对 agent 协作与度量零贡献；触屏无降级 | 降级为可选（保留，不入主线） |
| **sessionContext 注入**（v0.8） | 新会话消化注入的 digest，实际利用率低 | 保留但标记实验性，度量上线后可评估 |

### 外部证据支持的「鸡肋」原则

[《2026 年项目管理软件，我们被"功能冗余"拖累了》](https://worktile.com/kb/p/3979431)
与 [轻量级工具如何破解"工具越用越累"](https://cloud.tencent.cn/developer/article/2673929)
的共同结论：**每加一个没人用的功能，都在增加所有人的认知负担**。本项目当前的
鸡肋特征 = 「功能存在但入口不可用」（项目无创建）或「有人口但无消费」（只读命令、
拖拽对协作无贡献）——判定标准不是「有没有人用」，而是「是否服务 Q1–Q4」。

---

## 四、度量设计（零采集成本，数据已在活动流里）

活动流每条 `{action, from, to, at}` 已覆盖 created/status/blocked/claimed/
completed/edited/noted —— **一切时间度量可推导，无需埋点**：

| 度量 | 定义（活动流推导） | 回答什么 |
|---|---|---|
| **Lead time** | created → 最后一次 done | 从提出到交付总时长 |
| **Cycle time** | 首次 in_progress → done | 纯执行时长 |
| **等人时间 (awaiting-human)** | 进入 awaiting_human → 离开 | **人是不是瓶颈**（agent 协作关键） |
| **受阻时间 / 受阻率** | 进入 blocked → 离开；受阻任务占比 | 卡在哪 |
| **重做率 (rework)** | 打回次数 / 完成任务数（bounce = status→draft + noted） | agent 一次做对率 |
| **成功率** | settle completed / (completed + error) | agent 可靠性 |
| **吞吐 (throughput)** | 按天/周 done 数 | 产出节奏 |
| **逾期率** | dueAt 过期仍未 done 占比 | 承诺兑现 |
| **预算效率**（需新增） | 实际 token / budgetTokens（现状未落库） | 代价度量 |

**呈现原则**（避免过度设计）：一个 `/api/taskboard/stats` 端点 + 面板「概览」区
升级为**近 7/30 天趋势**（轻量条形/Sparkline，无完整 BI），加每任务「时间轴」视图
（复用活动抽屉：各状态驻留时长一目了然）。竞品 agent-board 只有完成率/平均时长
三个数；我们逐状态驻留 + 趋势直接领先一个身位。

---

## 五、产品化路线图

**V1.5 —— 度量与协作闭环（对齐用户点名）**
1. `/stats` 端点 + 面板趋势（lead/cycle/等人/受阻/吞吐/重做/成功率/逾期）
2. notes 注入派发 prompt（人的指示 agent 可见）+ 打回自动关联失败经验
3. 项目生命周期（解 E1 鸡肋：建项目/改名/迁移）
4. 失败策略可配置（autoRetry 与 human-in-loop 并存）
5. 实际 token 用量落库（预算效率度量）

**V1.6 —— 自动化循环（对齐竞品领先项）**
6. task chaining（完成 → 自动创建下一个，配模板）
7. 证据产物可点开（文件/commit）
8. /task 写命令（或删除只读命令）

**V1.7+ —— 生态与深度**
9. agent 间通信（notes 升级为线程，可选 webhook 唤醒）
10. 客户视图 / 项目模板（按需）
11. 触屏排序降级、MCP 暴露（如外部 agent 需要）

---

## 六、外部引用

- [agent-board — OpenClaw 多 agent 任务板（竞品）](https://github.com/quentintou/agent-board)
- [Kanban Lead and Cycle Time — 为什么重要](https://kanbantool.com/kanban-library/analytics-and-metrics/kanban-lead-and-cycle-time)
- [4 Essential Kanban Metrics in Jira（Lead/Cycle/WIP/Throughput）](https://saasjet.com/blog/4-essential-kanban-metrics-in-jira/)
- [AI agent performance metrics: what to track（n8n）](https://blog.n8n.io/what-metrics-should-i-track-for-ai-agent-performance/)
- [AI Agent Monitoring: Best Practices, Tools & Metrics（UptimeRobot）](https://uptimerobot.com/knowledge-hub/monitoring/ai-agent-monitoring-best-practices-tools-and-metrics/)
- [《2026 项目管理软件，我们被"功能冗余"拖累了》](https://worktile.com/kb/p/3979431)
- [轻量级项目管理工具如何破解"工具越用越累"](https://cloud.tencent.cn/developer/article/2673929)
