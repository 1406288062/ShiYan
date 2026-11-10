# Dots 技能库

Dots 后台任务智能体可复用的工作流程。每个技能一个目录、一个 `SKILL.md`，以只读方式挂进每个账号的沙箱
（`/home/agent/.claude/skills` 和 `/home/agent/.codex/skills`），Claude Agent SDK 与 Codex 都会自动发现。

来源：参考 Muse 的技能包（muse-core-capabilities/03-技能），只保留与 Dots 环境相符的部分并改写为中文；
Muse 专有的工具与路径（muse.*、/opt/muse）全部去掉。新增技能：建目录、写 SKILL.md（带 name/description 头），
下次唤醒任务时沙箱会按新规格重建并带上。
