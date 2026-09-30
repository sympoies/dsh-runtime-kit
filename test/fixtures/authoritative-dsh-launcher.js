export function authoritativeDshInvocation({ dshVersion, nodeBin, dshBin, args }) {
  switch (dshVersion) {
    case '0.2.0-rc.2':
    case '0.1.7-rc.1':
      return { command: nodeBin, args: [dshBin, ...args] }
    default:
      throw new Error('unsupported authoritative acceptance DSH version')
  }
}
