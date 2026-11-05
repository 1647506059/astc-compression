# ASTC 纹理配置（Creator 3.8.8）

由拼豆传送带的 `packages/astc` 移植，替换旧的 3.x ASTC 面板。仅使用 Node 内置模块，无需 npm install 或编译。

在扩展管理器重载 **astc**，从顶部 **纹理配置 → ASTC 纹理配置** 打开面板。

## 使用

1. 在资源管理器选择目录、`.pac`、PNG 或 JPG，点击“检索选中资源”；也可选择目录、输入 `db://assets/…`、`assets/…` 或当前工程 assets 内的绝对路径。
2. 选择小游戏、Android、iOS 或 Web 分组，查看图集、独立图片和当前压缩配置。支持路径筛选、仅看已有配置、每页 100 项及跨页勾选，检索过程可以停止。
3. 选择 ASTC 块大小、编码质量和回退图质量，点击“应用到勾选资源”。默认小游戏、ASTC 6×6、均衡质量、回退质量 80。
4. “移除勾选配置”只处理勾选项；“移除本次检索配置”处理整个检索结果，包含被图集接管的碎图遗留配置，不受关键词和仅看已有配置过滤影响。

PNG 和图集使用 ASTC + PNG 回退；JPG/JPEG 独立图片使用 ASTC + JPG 回退。图集归属按最近父目录、SpriteFrame 可合图属性及尺寸判断；同目录多个图集停止自动归属，显式选中单个图集仍可操作。最终合图结果、格式剔除和设备支持以构建及真机为准。

## 3.8 适配

- 通过 `Editor.Panel.define` 注册面板，使用 `Editor.Selection.getSelected`、`Editor.Dialog.select` 和 `Editor.Message.request('asset-db', …)`，不调用 2.4 的 `Editor.assetdb`。
- 查询主 `image` 与 `auto-atlas`，将 `@…` 图片子资源 UUID 还原到主图片。压缩设置写入主 Meta 的 `userData.compressSettings`，保留 UUID、子 Meta 和其他导入参数；串行保存后等待重导入完成并读回配置。
- 通过 `Editor.Profile` 读取/新增 builder 的 `textureCompressConfig.userPreset`。保留原预设中未选择的平台，生成并复用内容相同的预设副本，再让勾选资源引用它；不修改已有共享预设，不影响未勾选资源。
- 应用分组配置时，同时更新已有的对应具体平台覆盖；移除分组配置时，移除该组及其具体平台覆盖。没有覆盖的具体平台沿用 Creator 内置支持规则，不强制为所有小游戏平台添加 ASTC 覆盖。
- 移除全部有效格式后关闭该资源的压缩。失效预设、资源移动或保存失败会报告原因，不静默丢弃未知配置。新建预设后若资源保存失败，可能保留未引用预设，插件不会自动删除项目预设。
- 3.8 没有 2.4 `platformSettings.default` 的同义写法，因此界面使用四个明确的平台分组。图片尺寸来自 SpriteFrame Meta；没有尺寸信息的独立纹理显示“—”。

## 验证

```powershell
node --test extensions/astc/tests/texture-config.test.cjs
```

专项覆盖真实 3.8 Meta 结构、图集归属、PNG/JPG 回退、主图片 UUID、共享预设隔离、平台覆盖、应用/移除幂等、异常与取消处理，以及千张多选资源的请求去重和并发上限。测试使用内存 AssetDB/Profile，不修改工程图片。

官方依据：[3.8 压缩纹理](https://docs.cocos.com/creator/3.8/manual/zh/asset/compress-texture.html)、[项目设置中的压缩预设](https://docs.cocos.com/creator/3.8/manual/zh/editor/project/index.html)、[扩展配置系统](https://docs.cocos.com/creator/3.8/manual/zh/editor/extension/profile.html)。具体接口与预设格式同时核对本机 Creator 3.8.8 的类型声明。

## 仓库与版本分支

完整插件仓库：[astc-compression](https://github.com/1647506059/astc-compression)。

| Creator 版本 | 分支 | 同步工程 |
| --- | --- | --- |
| 2.4.15 | [2.4.15](https://github.com/1647506059/astc-compression/tree/2.4.15) | 拼豆、拼豆传送带、打毛线 |
| 3.8.8 | [3.8.8](https://github.com/1647506059/astc-compression/tree/3.8.8) | 倒沙子 |

当前分支为 **3.8.8**。仓库根目录就是完整的 astc 插件目录；两个版本的扩展声明和资源配置 API 不兼容，安装时请选择对应分支。

首次安装：在工程根目录执行以下命令；目标目录已存在时，先备份现有插件。

```powershell
git clone --branch 3.8.8 --single-branch https://github.com/1647506059/astc-compression.git extensions/astc
```

此版本只使用 Node 内置模块，无需安装依赖或编译。

通过 Git 克隆安装的插件，可在插件目录执行 `git pull --ff-only` 更新。已有工程内直接复制的插件，可下载对应分支后替换 `extensions/astc` 中的插件文件。更新后重载 astc 扩展；工程资源 Meta、压缩预设及本机面板历史属于工程或编辑器数据，不随插件源码发布。
