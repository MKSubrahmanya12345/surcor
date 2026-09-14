export const IPC = {
  FS_OPEN_FOLDER: "fs:openFolder",
  FS_READ_FILE: "fs:readFile",
  FS_WRITE_FILE: "fs:writeFile",
  FS_LIST_DIR: "fs:listDir",
  FS_CREATE_FILE: "fs:createFile",
  FS_DELETE_FILE: "fs:deleteFile",
  FS_RENAME: "fs:rename",

  // Terminal (Prompt 2)
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_EXIT: "terminal:exit",
  TERMINAL_KILL: "terminal:kill",

  // Git (Prompt 2)
  GIT_STATUS: "git:status",
  GIT_DIFF: "git:diff",
  GIT_STAGE: "git:stage",
  GIT_UNSTAGE: "git:unstage",
  GIT_DISCARD: "git:discard",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_PULL: "git:pull",
  GIT_CLONE: "git:clone",
  GIT_BRANCH: "git:branch",

  // GitHub (Prompt 2)
  GITHUB_START_AUTH: "github:startAuth",
  GITHUB_POLL_AUTH: "github:pollAuth",
  GITHUB_LIST_REPOS: "github:listRepos",
  GITHUB_STATUS: "github:status",
  GITHUB_SIGN_OUT: "github:signOut",
} as const;
