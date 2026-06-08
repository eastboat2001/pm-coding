# Git 操作指南

本仓库现在有两条主要开发分支：

- `main`：完整仓库，包含 `pm/` 和 `pi-mono-0.73.0/`。
- `vibecoding-platform`：PI-only 分支，只用于维护 `pi-mono-0.73.0/`。

不要把 `vibecoding-platform` 直接合并回 `main`，否则可能会把 `pm/` 在 `main` 上删除。

## 1. 查看当前状态

在做任何提交或推送前，先确认当前分支和工作区状态：

```powershell
git -C C:\PM-Coding branch --show-current
git -C C:\PM-Coding status
```

如果看到 `main`，当前是在完整仓库分支。

如果看到 `vibecoding-platform`，当前是在 PI-only 分支。

## 2. 切换分支

切换到完整仓库分支：

```powershell
git -C C:\PM-Coding switch main
```

切换到 PI-only 分支：

```powershell
git -C C:\PM-Coding switch vibecoding-platform
```

注意：本地同一个目录同一时间只能显示一个分支的文件状态。切换到不同分支后，`C:\PM-Coding` 里的文件会跟着变。

## 3. 推送完整仓库 main

适用于同时维护 PM 和 PI 的主分支。

```powershell
git -C C:\PM-Coding switch main
git -C C:\PM-Coding pull --ff-only origin main
git -C C:\PM-Coding status
```

确认要提交的内容没有问题后：

```powershell
git -C C:\PM-Coding add .
git -C C:\PM-Coding status
git -C C:\PM-Coding commit -m "你的提交说明"
git -C C:\PM-Coding push origin main
```

`main` 可以使用 `git add .`，因为它本来就包含 PM 和 PI。但提交前一定要看 `git status`，避免把 `.env`、日志、临时文件、构建产物误加进去。

## 4. 推送 PI-only 分支

适用于只维护 PI 项目，也就是 `pi-mono-0.73.0/`。

```powershell
git -C C:\PM-Coding switch vibecoding-platform
git -C C:\PM-Coding pull --ff-only origin vibecoding-platform
git -C C:\PM-Coding status
```

只添加 PI 目录：

```powershell
git -C C:\PM-Coding add pi-mono-0.73.0
git -C C:\PM-Coding status
git -C C:\PM-Coding commit -m "你的提交说明"
git -C C:\PM-Coding push origin vibecoding-platform
```

不建议在 `vibecoding-platform` 上习惯性使用 `git add .`。这个分支应该只提交 PI 相关内容，默认使用 `git add pi-mono-0.73.0` 更安全。

如果确实修改了根目录文件，例如 `.gitignore` 或这份 Git 操作指南，可以单独添加：

```powershell
git -C C:\PM-Coding add .gitignore
git -C C:\PM-Coding add git-operation-guide-zh.md
```

## 5. GitHub 黄色 Pull Request 提示

GitHub 看到新分支有推送时，会显示黄色提示：

```text
Compare & pull request
```

这是正常提示，不是报错。

对于 `vibecoding-platform`，不要直接点这个按钮把它合并回 `main`。因为这个分支相对 `main` 删除了 `pm/`，直接合并会影响主分支的 PM 项目。

## 6. 将 PI-only 的改动同步回 main

如果在 `vibecoding-platform` 上完成了 PI 开发，并且也希望 `main` 获得同样的 PI 改动，推荐只同步 `pi-mono-0.73.0/` 目录。

先确保两个分支工作区都是干净的：

```powershell
git -C C:\PM-Coding status
```

然后在 `main` 上从 PI-only 分支恢复 PI 目录：

```powershell
git -C C:\PM-Coding switch main
git -C C:\PM-Coding pull --ff-only origin main
git -C C:\PM-Coding restore --source=vibecoding-platform -- pi-mono-0.73.0
git -C C:\PM-Coding status
git -C C:\PM-Coding add pi-mono-0.73.0
git -C C:\PM-Coding commit -m "同步 PI 改动"
git -C C:\PM-Coding push origin main
```

这样只会同步 PI 目录，不会把 `vibecoding-platform` 中删除 `pm/` 的变更带回 `main`。

## 7. 本地同时保留两份目录

如果经常需要同时查看完整仓库和 PI-only 分支，建议使用 `git worktree`。

只需要执行一次：

```powershell
git -C C:\PM-Coding worktree add C:\PM-Coding-PI vibecoding-platform
```

之后：

- `C:\PM-Coding`：可以用于 `main`，包含 PM + PI。
- `C:\PM-Coding-PI`：可以用于 `vibecoding-platform`，只维护 PI。

在 `C:\PM-Coding-PI` 推送 PI-only 分支时：

```powershell
git -C C:\PM-Coding-PI status
git -C C:\PM-Coding-PI add pi-mono-0.73.0
git -C C:\PM-Coding-PI commit -m "你的提交说明"
git -C C:\PM-Coding-PI push origin vibecoding-platform
```

## 8. 常用检查命令

查看远端：

```powershell
git -C C:\PM-Coding remote -v
```

查看本地分支：

```powershell
git -C C:\PM-Coding branch
```

查看本地和远端分支关系：

```powershell
git -C C:\PM-Coding branch -vv
```

查看最近提交：

```powershell
git -C C:\PM-Coding log --oneline -5
```

确认 PI-only 分支是否还包含 PM 跟踪文件：

```powershell
git -C C:\PM-Coding switch vibecoding-platform
git -C C:\PM-Coding ls-files pm
```

如果没有任何输出，说明 `vibecoding-platform` 的 Git 内容里不包含 PM。

## 9. 推荐习惯

每次开始工作前：

```powershell
git -C C:\PM-Coding branch --show-current
git -C C:\PM-Coding pull --ff-only
git -C C:\PM-Coding status
```

每次提交前：

```powershell
git -C C:\PM-Coding status
git -C C:\PM-Coding diff --stat
```

每次推送后：

```powershell
git -C C:\PM-Coding status
git -C C:\PM-Coding branch -vv
```

核心原则：

- 在 `main` 上维护完整仓库。
- 在 `vibecoding-platform` 上只维护 PI。
- 不要把 `vibecoding-platform` 直接 merge 到 `main`。
- 从 PI-only 同步到 `main` 时，只同步 `pi-mono-0.73.0/`。
