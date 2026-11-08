#!/usr/bin/env python3
# =============================================================================
# 用 GitHub Git Data API 推送本地 main 分支
# -----------------------------------------------------------------------------
# 用途：git push 连不上时的兜底路径。
#
# 为什么需要它：这条网络下 git push 经常报 "Recv failure: Connection was reset"，
# 但 gh api 是通的。走 API 上传能拿到完全一样的仓库内容。
#
# 用法：
#   python3 tools/push-via-api.py <owner/repo> [分支名]
#
# 关键坑（照着做，别改）：
#   ① **传仓库里的 blob 字节，不是工作区文件字节。**
#      工作区被 autocrlf 改成 CRLF，blob SHA 与远端对不上，
#      文件会一直显示「已修改」。所以每个文件用 `git cat-file blob <sha>` 取原始内容。
#   ② tree 自底向上传。GitHub 会重算 tree SHA，以返回值为准。
#   ③ commit 的 parents 必须是 40 位完整 SHA（远端 API 返回的那个）。
#   ④ 并发上传 blob —— 一百多个文件串行传要好几分钟，8 路并发十几秒就完。
# =============================================================================
import base64
import hashlib
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

REPO = sys.argv[1] if len(sys.argv) > 1 else "liluwei-star/stepx-studio"
BRANCH = sys.argv[2] if len(sys.argv) > 2 else "main"


def git(*args):
    """跑一条 git 命令，拿到原始字节（不要经过文本解码，blob 必须是字节）。"""
    result = subprocess.run(["git"] + list(args), capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "git %s 失败：%s" % (" ".join(args), result.stderr.decode("utf-8", "replace")[:300])
        )
    return result.stdout


def gh(endpoint, payload=None):
    """调 GitHub API。payload 是 dict 时按 JSON 发送。"""
    command = ["gh", "api", endpoint]
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        command += ["--method", "POST", "--input", "-"]
    result = subprocess.run(command, input=body, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "gh api %s 失败：%s" % (endpoint, result.stderr.decode("utf-8", "replace")[:300])
        )
    raw = result.stdout.decode("utf-8")
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def blob_sha(content: bytes) -> str:
    """git blob 的 SHA-1 算法：sha1("blob " + 字节数 + NUL + 内容)。

    注意字节数是**字节**不是字符 —— 中文按 UTF-8 字节算才对得上。
    """
    header = ("blob %d\0" % len(content)).encode("utf-8")
    return hashlib.sha1(header + content).hexdigest()


def remote_tree_files(tree_sha):
    """递归展开远端 tree，返回 {路径: blob sha}。"""
    files = {}
    stack = [("", tree_sha)]
    while stack:
        prefix, sha = stack.pop()
        for entry in gh("repos/%s/git/trees/%s" % (REPO, sha))["tree"]:
            path = prefix + entry["path"]
            if entry["type"] == "tree":
                stack.append((path + "/", entry["sha"]))
            else:
                files[path] = entry["sha"]
    return files


def main():
    local_tree_sha = git("rev-parse", "HEAD^{tree}").decode().strip()

    # 列出 HEAD 里的全部文件
    tree_entries = []
    for line in git("ls-tree", "-r", "HEAD").decode("utf-8").strip().split("\n"):
        if not line.strip():
            continue
        meta, path = line.split("\t", 1)
        mode, _kind, sha = meta.split()
        tree_entries.append((mode, path, sha))
    print("  本地提交含 %d 个文件" % len(tree_entries))

    # 远端现状
    ref = gh("repos/%s/git/ref/heads/%s" % (REPO, BRANCH))
    remote_commit = ref["object"]["sha"]
    remote_commit_sha = gh("repos/%s/git/commits/%s" % (REPO, remote_commit))
    remote_files = remote_tree_files(remote_commit_sha["tree"]["sha"])

    # 只传远端没有或内容不同的
    pending = []
    for mode, path, sha in tree_entries:
        content = git("cat-file", "blob", sha)
        calculated = blob_sha(content)
        if calculated != sha:
            raise RuntimeError("文件 %s 的 blob SHA 算错了" % path)
        if remote_files.get(path) != calculated:
            pending.append((mode, path, calculated, content))
    print("  需要上传 %d 个文件（其余远端已有且一致）" % len(pending))

    if pending:
        def upload(item):
            _mode, path, sha, content = item
            gh(
                "repos/%s/git/blobs" % REPO,
                {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"},
            )
            return path

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(upload, pending))
        print("  blob 上传完成")

    # 建新 tree（基于远端 tree，这样远端多出来的文件不会被删）
    if pending:
        new_tree = gh(
            "repos/%s/git/trees" % REPO,
            {
                "base_tree": remote_commit_sha["tree"]["sha"],
                "tree": [
                    {"path": path, "mode": mode, "type": "blob", "sha": sha}
                    for mode, path, sha, _ in pending
                ],
            },
        )
        new_tree_sha = new_tree["sha"]
    else:
        # 没有任何文件变化 —— GitHub 不接受空的 tree 数组（422），直接复用远端 tree
        new_tree_sha = remote_commit_sha["tree"]["sha"]

    # 建 commit
    message = git("log", "-1", "--format=%B").decode("utf-8").strip() or "Update"
    commit = gh(
        "repos/%s/git/commits" % REPO,
        {"message": message, "tree": new_tree_sha, "parents": [remote_commit]},
    )
    new_sha = commit["sha"]

    # 内容完全一致时不要新建空 commit —— 否则远端 main 每次都漂移，
    # 已发布 Release 的 tag 会跟 main 错位，AppUpdater 也会拿到对不上的源码。
    if not pending and new_tree_sha == remote_commit_sha["tree"]["sha"]:
        print("  远端内容与本地一致，无需提交，跳过")
        return 0

    # 推分支
    gh(
        "repos/%s/git/refs/heads/%s" % (REPO, BRANCH),
        {"sha": new_sha},
    )

    # 本地 tag 若指向旧 commit，把它挪到新 commit（否则 Release 会跟源码错位）。
    # 只处理本地已有的 tag，不会凭空造一个。
    for line in git("tag", "--points-at", "HEAD").decode("utf-8").split():
        try:
            gh("repos/%s/git/refs/tags/%s" % (REPO, line), {"sha": new_sha, "force": True})
            print("  tag %s 已指向新提交" % line)
        except Exception as error:
            print("  tag %s 更新失败（忽略）：%s" % (line, error))

    print("  推送完成：%s" % new_sha)
    return 0


if __name__ == "__main__":
    sys.exit(main())
