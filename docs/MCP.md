# Athria MCP Interface Guide

Athria 通过 MCP 向 AI Agent 暴露本地训练数据、计划、确定性计算和有限的写操作。

这份文档面向使用和开发 Athria MCP 的人，重点说明：**每个接口是做什么的，以及应该在什么场景下使用。** 具体字段和 JSON Schema 以 MCP `tools/list` 返回的 contract 为准。

## 设计原则

Athria 的 MCP 可以简单理解为五层：

1. **Context**：读取用户资料、训练历史、Wellness 和当前状态。
2. **Planning**：读取、验证和保存训练计划。
3. **History**：记录用户实际完成的训练。
4. **Reconciliation**：由 Athria 自动匹配 History 与 Plan，MCP 只提供用户确认后的纠错入口。
5. **Deterministic Core**：1RM、心率区间、progression、RPE 调整等由确定性代码计算，不交给 LLM 猜。

原则上，LLM 负责理解用户意图、组织信息和解释结果；Athria Core 负责计算、验证、状态一致性和自动 reconciliation。

---

## 1. Athlete / Training Context

| Tool | 功能 |
| --- | --- |
| `get_athlete_profile` | 读取已确认的 Athlete Profile、训练约束，以及更新 Profile 时需要的 hash。 |
| `get_training_state` | 获取当前训练状态快照、聚合指标和 `inputSnapshotHash`。保存或调整计划前通常需要读取。 |
| `list_training_sessions` | 读取一段时间内标准化后的 Training History。 |
| `get_training_summary` | 获取近期按训练领域拆分的汇总指标。适合快速了解最近训练情况。 |
| `list_wellness` | 读取一段时间内的 Wellness 数据，并保留字段来源。 |
| `get_wellness_day` | 获取某一天的 Wellness，以及更新该天数据所需的 hash。 |

### Profile 与 Wellness

Profile 用于相对稳定的个人和训练设定，例如训练目标、训练节奏、设备、限制等。

Weight 等按日期变化的数据属于 Wellness，不应写入 Profile。

---

## 2. Xunji / 训记

| Tool | 功能 |
| --- | --- |
| `list_xunji_training_sessions` | 读取已经同步到 Athria 本地数据库的训记训练记录。不会直接访问训记实时 API。 |
| `get_xunji_sync_status` | 查看训记最近同步时间、范围和状态，不暴露 API Key。 |

Xunji MCP 接口是只读的。同步动作由 Athria Dashboard 的 Devices 页面负责。

---

## 3. Taxonomy 与 Session Templates

| Tool | 功能 |
| --- | --- |
| `get_training_taxonomy` | 获取 Athria 当前版本化的 movement、muscle 等标准词汇。创建 Template 或结构化动作分类前应先读取。 |
| `list_session_templates` | 列出内置和用户创建的 Session Template。 |
| `get_session_template` | 获取一个具体 Template。 |
| `create_session_template` | 创建用户自己的可复用单领域训练 archetype。 |
| `update_session_template` | 修改用户 Template。修改 Template 不会反向修改已经生成的 Weekly Sessions。 |
| `delete_session_template` | 删除用户 Template，或隐藏内置 Template。需要用户明确要求。 |

### Template 不是完整训练处方

Template 表示可复用的训练结构或 archetype，不保存具体的 executable dose。

例如它可以描述“Upper Strength”包含哪些结构节点，但最终的训练重量、组数、次数、时长等应写入具体的 Weekly Session。

`templateRef` 只是 provenance/reference，不能用来补全缺失的 Session 内容。

---

## 4. Deterministic Calculations

这些接口不会修改数据。同样输入应得到同样结果，用来避免 LLM 自己计算或猜测训练指标。

| Tool | 功能 |
| --- | --- |
| `calculate_training_metrics` | 基于本地 Training History 计算确定性的 Strength / Endurance 指标。 |
| `estimate_1rm` | 使用版本化的 Epley 公式估算 1RM。 |
| `calculate_heart_rate_zones` | 根据用户明确提供的最大心率计算 5 个心率区间。不会自行根据年龄猜最大心率。 |
| `evaluate_progression` | 根据当前 prescription 和完成情况评估 progression，例如是否应该增加负重。 |
| `evaluate_rpe_autoregulation` | 当用户提供实际 RPE 时，评估相对目标 RPE 的负重调整。没有 RPE 时不应推断。 |

这些结果可以被 Agent 用来解释和提出建议，但计算逻辑属于 Athria Core。

---

## 5. Current Plan

| Tool | 功能 |
| --- | --- |
| `get_current_plan` | 获取当前唯一可编辑的 Mesocycle。 |
| `validate_current_plan` | 对候选 Current Plan 做确定性验证，不保存。 |
| `save_current_plan` | 用户明确批准后，原子地替换当前完整 Mesocycle。 |
| `get_plan_adjustment_review` | 基于最新 Profile、Training、Calendar 和 Wellness 判断当前计划是否需要 review，并返回原因、范围、hard overrides 和 data gaps。不会修改计划。 |

### `save_current_plan`

这是完整计划写入接口，不是 patch。

推荐流程：

```text
读取当前 Profile / State / Plan
        ↓
生成完整候选计划
        ↓
validate_current_plan
        ↓
向用户展示变化
        ↓
用户明确批准
        ↓
重新检查 revision / snapshot / profile freshness
        ↓
save_current_plan
```

如果数据已经变化，应重新读取和 rebase，而不是覆盖新状态。

---

## 6. Next Training Day / Planned Sessions

| Tool | 功能 |
| --- | --- |
| `get_next_training_day` | 获取指定日期之后第一个仍有未完成训练的 scheduled day。 |
| `list_planned_sessions` | 列出 Current Plan 中的 Planned Sessions，可按日期范围过滤。 |
| `validate_next_training_day_sessions` | 验证准备写入下一训练日的 Session，不保存。 |
| `save_next_training_day_sessions` | 用户确认后，在下一训练日追加或替换完整可执行 Session。 |
| `update_planned_session` | 用户确认后，对一个 planned occurrence 执行完成、跳过、恢复或移动等动作。 |

### `save_next_training_day_sessions`

这个接口写的是 **未来准备练什么**，不是 Training History。

支持：

- `append`：在当天已有 Session 后追加。
- `replace`：替换当天的 Session。

写入的每个 Session 都应是完整可执行处方，不能依赖 Template 在运行时补字段。

---

## 7. Training History

| Tool | 功能 |
| --- | --- |
| `record_training_session` | 记录用户实际完成的一次训练，写入 Training History。 |
| `update_manual_training_session` | 修改包含 manual source 的 canonical workout 的开始时间或时长。 |
| `remove_manual_training_source` | 从 canonical workout 中移除 manual source；不会删除同步来源的数据。 |

### Plan 与 History 的区别

```text
Plan     = 应该练什么
History  = 实际练了什么
```

`record_training_session` 写的是事实记录，不应该用来改计划。

`record_training_session` 不接受 `plannedSessionId`。无论关系看起来多明确，正常 matching 都必须交给 Athria 的 deterministic reconciliation algorithm，LLM 不得自行选择计划项。

---

## 8. Plan ↔ History Reconciliation

Athria 会使用 deterministic reconciliation algorithm 自动判断 canonical workout 是否对应某个 Planned Session。

正常 matching **不由 LLM 执行**。

| Tool | 功能 |
| --- | --- |
| `override_training_session_plan_match` | 仅当用户明确指定、纠正、替换或否定某个 match 时，应用该 workout ↔ planned session 覆盖。传 `null` 表示用户明确将该 workout 标记为 intentionally unplanned。 |
| `allow_automatic_plan_match` | 用户明确确认后，撤销 intentionally-unplanned exclusion，再次允许 Athria 的 deterministic matcher 自动判断。 |

典型流程：

```text
Training History
      ↓
Athria automatic matcher
      ↓
┌───────────────┬────────────────┐
│ confident     │ ambiguous/wrong│
↓               ↓
auto match      保持未匹配或等待用户纠正
                    ↓
          用户明确指定关系
                    ↓
  override_training_session_plan_match
```

如果用户明确说某次 workout 与任何计划都无关，可以设置：

```text
plannedSessionId = null
```

Athria 将其视为 intentionally unplanned，避免自动 matcher 之后再次误匹配。

如果用户希望撤销这一决定，再调用 `allow_automatic_plan_match`。

---

## 9. Profile / Wellness Updates

| Tool | 功能 |
| --- | --- |
| `update_athlete_profile` | 用户明确确认后更新 Athlete Profile。使用 hash 防止覆盖较新的状态。 |
| `update_wellness` | 用户明确确认后更新某一天的 Wellness。使用 snapshot hash 做并发保护。 |

Agent 不应根据推测直接修改 Profile 或 Wellness。

---

## 常见工作流

### 创建或修改训练计划

```text
get_athlete_profile
get_training_state
get_current_plan
get_training_taxonomy
        ↓
读取必要的 History / Wellness
        ↓
生成候选 Plan
        ↓
validate_current_plan
        ↓
用户确认
        ↓
save_current_plan
```

### 临时调整下一训练日

```text
get_next_training_day
        ↓
生成完整 Session
        ↓
validate_next_training_day_sessions
        ↓
用户确认
        ↓
save_next_training_day_sessions
```

### 记录实际训练

```text
用户提供实际训练事实
        ↓
record_training_session
        ↓
Athria automatic reconciliation
        ↓
必要时由用户人工纠正 match
```

### 调整训练 progression

```text
Training History
        ↓
evaluate_progression / evaluate_rpe_autoregulation
        ↓
Agent 解释结果
        ↓
如需改变未来训练，再修改 Plan
```

---

## 写操作与确认

以下操作会改变 Athria 本地状态。Agent 应遵循工具 contract 中的 confirmation、revision 和 snapshot 要求：

- Template 创建、修改、删除
- Current Plan 保存
- Next Training Day Session 写入
- Planned Session action
- Training History 写入或人工修改
- Plan match 人工覆盖
- Profile / Wellness 更新

其中删除、替换、移动、重新关联等操作属于 destructive mutation，应特别避免在没有用户明确意图的情况下执行。

---

## 一句话理解 Athria MCP

> **LLM 负责理解、组织和解释；Athria Core 负责事实、计算、验证、状态一致性和自动匹配。**

MCP 是两者之间的受控接口层。
