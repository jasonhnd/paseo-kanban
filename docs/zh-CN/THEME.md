# 跟随宿主主题的颜色

看板跟随 Paseo 当前主题，没有独立的浅色／深色调色板或颜色模式偏好。
适配器使用 `@getpaseo/plugin` 0.11.0 的 `PluginTheme` 中全部 11 个语义颜色。

## 主题更新

`theme` 是 React 组件的 prop，由注册的全局页、工作区面板和设置页继承自
`PluginHostProps`，不是注册时 `PluginClientContext` 的成员。每次渲染读取当前值：

```tsx
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { paletteFromTheme } from "../shared/palette";

function Panel({ theme }: PluginSurfaceProps) {
  const p = paletteFromTheme(theme);
  // 使用 p.bg、p.card、p.text 等派生值渲染。
}
```

`useStyles` 每次从 prop 重新计算，不需要主题 RPC、轮询、订阅或重新注册面板。
不要把首次主题保存在模块状态或没有依赖的 memo 中。Web 和原生布局使用相同的 prop 契约。

## 调色规则

`shared/palette.ts` 是纯适配器。混色对宿主颜色的通道（含 alpha）做插值；
透明度乘以宿主 alpha。生成的十六进制值适用于 React Native 和 Web。

| 看板用途 | 宿主来源或派生方法 |
| --- | --- |
| 页面、抽屉 | `surface0` |
| 卡片 | `surface1` |
| 浮起的表面、轨道 | `surface2` |
| 列 | `surface0` 与 `surface1` 等量混色 |
| 边框 | `border` |
| 正文 | `foreground` |
| 次要文字、占位符 | `foregroundMuted`；页面、卡片或浮起表面对比低于 4.5:1 时，以 .05 步长混入 `foreground` |
| 装饰性淡点 | `border` 与 `foregroundMuted` 等量混色 |
| 主按钮、选中分段 | `accent`、`accentForeground` |
| 状态徽标背景 | `surface1` 混入 .1 的对应状态色 |
| 强调徽标背景 | `surface1` 混入 .1 的 `accent` |
| 状态、链接文字 | 对应状态色或 `accent`；必要时混入 `foreground`，使页面、卡片、徽标上达到 4.5:1 |
| 透明背景、边框 | `surface0` 的 alpha 乘以 0 |
| 抽屉遮罩 | `surface0` 的 alpha 乘以 .65 |

支持简写、完整、带 alpha 的十六进制及 CSS RGB 通道。不认识的格式保留宿主端点，
不增加固定色相；这种格式的混色、透明度和对比调整不能保证。可读性也依赖宿主前景与表面配对。

## 源码与偏好规则

1. 只用 11 个宿主值、混色或透明度调整。`test/theme-source.test.ts` 扫描
   `client/`、`shared/` 的 JS/TS 字面量、模板和 JSON 字符串中的十六进制、RGB/HSL、命名颜色。
   唯一源码例外是 `shared/theme-fallback.ts`；测试夹具放在 `test/`。共用闸脚本不变。
2. 没有 theme 时只用 `shared/theme-fallback.ts` 集中的一套中性灰度。宿主 theme 始终优先。
3. 深浅判断只看 `surface0` 相对亮度：sRGB 线性化，权重 .2126/.7152/.0722，阈值 .179。
   插件不读取系统外观 API；调色板不选择深浅颜色表。
4. 类别用深浅、图标、名称或线型区分。服务商和角色用文字区分，类别链接共用宿主强调色。
   成功、警告、危险这些语义状态仍使用对应宿主 token。
5. 浅、深两套彩色夹具各有 11 个值，同套和跨套均不同。纯函数测试覆盖映射和全部输入。
   挂载的全局／项目看板在 Web 和模拟 iOS 下原地更新 prop，检查全部颜色更新、抽屉保留和设置页。

旧 `colorMode` 读取时忽略，下次保存字体偏好时移除，其他未知字段保留。
迁移来源文件不变。偏好 RPC 和英文／简体中文界面删除该字段和控件，字体大小仍可设置。

## 真实面板验证

使用一次性的 `paseo --home`、独立回环端口和演示数据，HOME 保持原值。
启动前将看板、Fleet、角色、工作区和临时目录全部指向隔离环境。安装候选副本，
通过 Paseo Appearance 选择 Light 和一个深色主题，各截全局看板、真实项目工作区面板、
抽屉、设置页，再截实时切换对比。做完停止隔离 daemon。

已在 Paseo 0.11.2 Web 检查 Light 与 Midnight。System 从浅到深的切换在同一
document 和路由中更新了已打开的项目面板，没有导航或重开。宿主替换了卡片节点；
另一次切换确认打开的抽屉会关闭，这是宿主重新挂载的限制。

本机结果见[工具链验证](../TOOLCHAIN-VALIDATION.md)。挂载测试证明同一插件实例内
prop 更新能保留状态，不能承诺宿主保留实例；宿主重新挂载可能关闭抽屉。
物理 iOS／Android 设备和生产桌面会话需要另外验证。

[English](../THEME.md)
