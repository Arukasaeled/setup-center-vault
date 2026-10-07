# Setup Center Vault — 内容与资产许可政策 (CONTENT_LICENSING.md)

> 本文档规范 Setup Center Vault 独立内容仓库中各类创作资产、样式系统、脚手架模板与技能元数据的授权使用政策（Issue J07）。

---

## 1. 仓库定位与许可总则

Setup Center Vault 作为解耦的远程内容库，为 Setup Center 客户端提供运行时热更新与离线资产支持。

- **根许可证提案**：
  - 拟定方案：**MIT License**（涵盖代码、脚本与模板）+ **CC-BY-4.0**（涵盖元数据与文档）。
- **当前决定状态**：**`BLOCKED_INPUT`**
  - 正式根许可证的采纳需由仓库所有者（Arukasaeled）进行最终确认。

---

## 2. 分类内容资产授权细则

| 资产类别 | 存放路径 | 推荐授权协议 | 使用边界说明 |
| :--- | :--- | :--- | :--- |
| **精选资源元数据** | `resources/*.json` | **CC0 1.0 / CC-BY-4.0** | 结构化元数据（名称、描述、官网、Star 观测值、推荐理由），允许自由检索与重组。被索引的各开源工具遵循其自身的开源许可证。 |
| **视觉风格系统** | `styles/*/` | **MIT License** | 包含 20 套视觉体验清单与 CSS 样式表，允许在个人与商业项目中自由复用、微调与定制。 |
| **工程脚手架模板** | `templates/*/` | **The Unlicense / MIT-0** | 包含 28 款项目脚手架定义与初始化配方。生成的工程代码属于公共领域，不施加任何传染性限制，支持直接闭源商业化。 |
| **UI 交互模式** | `patterns/*/` | **MIT License** | 包含 34 套 WAI-ARIA 规范与交互模式定义。 |
| **Agent 迁移技能** | `skills/*/` | **MIT License** | 包含 21 项 Agent 工作流与自动化技能指南。 |
| **Schema 规范** | `schemas/*.schema.json` | **MIT License** | JSON Schema 格式规范与验证契约。 |

---

## 3. 第三方商标与品牌指示性引用

Vault 目录中包含的各类开发工具与服务名称（如 Vite, React, Tauri, Rust, Python, Tailwind, Claude, OpenAI 等）均为各自所有者的注册商标。本仓库仅出于**指示性合理引用（Nominative Fair Use）**目的收录其元数据并向开发者推荐，不代表任何官方背书或从属关系。
