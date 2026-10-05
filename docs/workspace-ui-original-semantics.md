# 工作区 UI 的原始语义（从 git 取证，不是推测）

> 这份文件是为了防止"凭函数签名猜交互"这类错误再次发生。每条都附取证位置。
> 取证版本：`bc6689a^`（即删除 `NewWorkspaceDialog.tsx` 之前的那次提交）。

## 1. 创建工作区 = 输入名称直接创建，没有选择、没有目录

`packages/workspace-k8s/src/client/NewWorkspaceDialog.tsx`（`git show bc6689a^:<path>`）：

- 标题：**「新建工作区」**
- 说明文案：**「输入工作区名称。创建后会出现在侧边栏工作区组中。」**
- 表单内容：**只有一个** `<input id="dsh-ws-name" placeholder="例如：my-project">`，Enter 提交；页脚是「取消 / 创建」。
- 提交调用：`await createByName(name)`；错误显示在弹窗内并回调 `onError`。

`index.tsx` 同版本：

```ts
const createByName = async (name: string): Promise<void> => {
  await workspaceApi.create(name)   // 只传 name
  await poll()
}
```

**结论**：没有路径输入、没有目录浏览、没有"从已有工作区里挑一个"。
创建工作区的输入是**名字**，不是位置。

## 2. `directoryFlow` 是槽位名，不是"要浏览目录"

同版本 `index.tsx`：

```ts
ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.register({ … priority: -100 }, NewWorkspaceDialog))
ctx.slots.inject('sidebar.workspaces.directoryFlow',              () => ctx.slots.register({ … priority: -100 }, NewWorkspaceDialog))
```

两个 `directoryFlow` 洞被**我们的对话框占据**（`priority: -100`），用来渲染"新建工作区"弹窗。
看到槽位叫 `directoryFlow` 就断言"用户要选目录"是**错误推断**——这是已经犯过的错。

## 3. 工作区 id 不是目录，不得按目录树呈现

`git`、`test-pod`、`f49f56f4-…` 这些是**工作区标识**（同时也是 PVC 名与锚点目录名，所以看起来像路径）。
把工作区列表渲染成目录树，在语义上是错的：它们不是文件夹，用户也没有"进入某个目录"的心智模型。

## 4. 会话的工作区详情页是既有功能，不是可选装饰

`packages/workspace-k8s/src/client/WorkspaceDetailView.tsx` 在 `7aa7e60` 被删除。
用户明确要求恢复。

## 5. 删除工作区必须连带删除 PVC

用户已两次明确要求：**显式删除就是删除**，包括官方侧栏那条入口。
现状：我们自己的删除已删 pod+service+PVC；官方入口只删记录，reconciler 会从残留 PVC 重建（实测 68 秒后复活）。
`"有 PVC 无记录"` 存在歧义（刚被删 vs 外部带入），必须设计判别依据并两个分支都测；判别不成立时宁可停下报告，也不许误删数据。

## 6. 状态呈现的位置

- `main` 面板 + `sidebar.panellist` 入口：保留。
- `shell.overlay` 药丸：**不得压住左上角 logo**；用户不理解其含义（"工作区：3 个休眠中"）。要么挪到不重叠且自明的位置，要么删除。
