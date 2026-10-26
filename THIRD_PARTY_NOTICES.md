# 第三方组件

PiQ Harness 的源码按 GNU Affero General Public License v3.0 发布，完整条款见 [LICENSE](LICENSE)。第三方组件保留各自的版权和许可证。

## 网络接入

OneBot 11 网络客户端为独立实现，使用 Node.js 原生 WebSocket。协议依据 [OneBot 11 标准](https://github.com/botuniverse/onebot-11)；仓库未包含 SnowLuma SDK 或 SnowLuma 后端源码。

SnowLuma 是需要另行安装的外部服务，其使用与分发遵循 [SnowLuma 自身许可证](https://github.com/SnowLuma/SnowLuma/blob/v2.2.0/LICENSE)。本项目的 AGPL 许可范围为 PiQ Harness，不会改变该服务的许可。

## npm 依赖

此源码仓库包含依赖声明与锁文件。npm 安装的第三方包遵循各包附带的许可证与版权声明；分发这些包时应一并保留相应声明。

主要直接依赖与开发工具：

| 组件 | 许可证 |
| --- | --- |
| Pi Coding Agent 及 Pi 组件 | MIT |
| TypeBox | MIT |
| TypeScript | Apache-2.0 |
| Node.js 类型定义 | MIT |

当前锁文件中的其余第三方依赖使用 MIT、Apache-2.0、BSD-3-Clause、ISC、BlueOak-1.0.0、Unlicense 或 0BSD。具体组件、版本与完整声明以 package-lock.json 及对应包的许可证文件为准。
