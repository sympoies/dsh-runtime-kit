export function authoritativeDshInvocation({ dshVersion, nodeBin, dshBin, pnpmBin, args }) {
  switch (dshVersion) {
    case '0.1.6-alpha.2':
      return { command: nodeBin, args: [dshBin, ...args] }
    case '0.1.5-alpha.2':
      return { command: pnpmBin, args: ['dsh', ...args] }
    default:
      throw new Error('unsupported authoritative acceptance DSH version')
  }
}
