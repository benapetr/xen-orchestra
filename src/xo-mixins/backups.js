import endsWith from 'lodash.endswith'
import escapeStringRegexp from 'escape-string-regexp'
import eventToPromise from 'event-to-promise'
import filter from 'lodash.filter'
import findIndex from 'lodash.findindex'
import sortBy from 'lodash.sortby'
import startsWith from 'lodash.startswith'
import {
  basename,
  dirname
} from 'path'
import { satisfies as versionSatisfies } from 'semver'

import vhdMerge from '../vhd-merge'
import xapiObjectToXo from '../xapi-object-to-xo'
import {
  deferrable
} from '../decorators'
import {
  forEach,
  mapToArray,
  noop,
  pCatch,
  pSettle,
  safeDateFormat
} from '../utils'
import {
  VDI_FORMAT_VHD
} from '../xapi'

// ===================================================================

const DELTA_BACKUP_EXT = '.json'
const DELTA_BACKUP_EXT_LENGTH = DELTA_BACKUP_EXT.length

// Test if a file is a vdi backup. (full or delta)
const isVdiBackup = name => /^\d+T\d+Z_(?:full|delta)\.vhd$/.test(name)

// Test if a file is a delta vdi backup.
const isDeltaVdiBackup = name => /^\d+T\d+Z_delta\.vhd$/.test(name)

// Get the timestamp of a vdi backup. (full or delta)
const getVdiTimestamp = name => {
  const arr = /^(\d+T\d+Z)_(?:full|delta)\.vhd$/.exec(name)
  return arr[1]
}

const getDeltaBackupNameWithoutExt = name => name.slice(0, -DELTA_BACKUP_EXT_LENGTH)
const isDeltaBackup = name => endsWith(name, DELTA_BACKUP_EXT)

async function checkFileIntegrity (handler, name) {
  let stream

  try {
    stream = await handler.createReadStream(name, { checksum: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      return
    }

    throw error
  }

  stream.resume()
  await eventToPromise(stream, 'finish')
}

// ===================================================================

export default class {
  constructor (xo) {
    this._xo = xo
  }

  async listRemoteBackups (remoteId) {
    const handler = await this._xo.getRemoteHandler(remoteId)

    // List backups. (No delta)
    const backupFilter = file => endsWith(file, '.xva')

    const files = await handler.list()
    const backups = filter(files, backupFilter)

    // List delta backups.
    const deltaDirs = filter(files, file => startsWith(file, 'vm_delta_'))

    for (const deltaDir of deltaDirs) {
      const files = await handler.list(deltaDir)
      const deltaBackups = filter(files, isDeltaBackup)

      backups.push(...mapToArray(
        deltaBackups,
        deltaBackup => {
          return `${deltaDir}/${getDeltaBackupNameWithoutExt(deltaBackup)}`
        }
      ))
    }

    return backups
  }

  async importVmBackup (remoteId, file, sr) {
    const handler = await this._xo.getRemoteHandler(remoteId)
    const stream = await handler.createReadStream(file)
    const xapi = this._xo.getXapi(sr)

    await xapi.importVm(stream, { srId: sr._xapiId })
  }

  // -----------------------------------------------------------------

  @deferrable.onFailure
  async deltaCopyVm ($onFailure, srcVm, targetSr) {
    const srcXapi = this._xo.getXapi(srcVm)
    const targetXapi = this._xo.getXapi(targetSr)

    // Get Xen objects from XO objects.
    srcVm = srcXapi.getObject(srcVm._xapiId)
    targetSr = targetXapi.getObject(targetSr._xapiId)

    // 1. Find the local base for this SR (if any).
    const TAG_LAST_BASE_DELTA = `xo:base_delta:${targetSr.uuid}`
    const localBaseUuid = (id => {
      if (id != null) {
        const base = srcXapi.getObject(id, null)
        return base && base.uuid
      }
    })(srcVm.other_config[TAG_LAST_BASE_DELTA])

    // 2. Copy.
    const dstVm = await (async () => {
      const delta = await srcXapi.exportDeltaVm(srcVm.$id, localBaseUuid, {
        snapshotNameLabel: `XO_DELTA_EXPORT: ${targetSr.name_label} (${targetSr.uuid})`
      })
      $onFailure(async () => {
        await Promise.all(mapToArray(
          delta.streams,
          stream => stream.cancel()
        ))

        return srcXapi.deleteVm(delta.vm.$id, true)
      })

      const promise = targetXapi.importDeltaVm(
        delta,
        {
          deleteBase: true, // Remove the remote base.
          srId: targetSr.$id
        }
      )

      // Once done, (asynchronously) remove the (now obsolete) local
      // base.
      if (localBaseUuid) {
        promise.then(() => srcXapi.deleteVm(localBaseUuid, true))::pCatch(noop)
      }

      // (Asynchronously) Identify snapshot as future base.
      promise.then(() => {
        return srcXapi._updateObjectMapProperty(srcVm, 'other_config', {
          [TAG_LAST_BASE_DELTA]: delta.vm.uuid
        })
      })::pCatch(noop)

      return promise
    })()

    // 5. Return the identifier of the new XO VM object.
    return xapiObjectToXo(dstVm).id
  }

  // -----------------------------------------------------------------

  // TODO: The other backup methods must use this function !
  // Prerequisite: The backups array must be ordered. (old to new backups)
  async _removeOldBackups (backups, handler, dir, n) {
    if (n <= 0) {
      return
    }

    const getPath = (file, dir) => dir ? `${dir}/${file}` : file

    await Promise.all(
      mapToArray(backups.slice(0, n), async backup => /* await */ handler.unlink(getPath(backup, dir)))
    )
  }

  // -----------------------------------------------------------------

  async _legacyImportDeltaVdiBackup (xapi, { vmId, handler, dir, vdiInfo }) {
    const vdi = await xapi.createVdi(vdiInfo.virtual_size, vdiInfo)
    const vdiId = vdi.$id

    // dir = vm_delta_xxx
    // xoPath = vdi_xxx/timestamp_(full|delta).vhd
    // vdiDir = vdi_xxx
    const { xoPath } = vdiInfo
    const filePath = `${dir}/${xoPath}`
    const vdiDir = dirname(xoPath)

    const backups = await this._listDeltaVdiDependencies(handler, filePath)

    for (const backup of backups) {
      const stream = await handler.createReadStream(`${dir}/${vdiDir}/${backup}`)

      await xapi.importVdiContent(vdiId, stream, {
        format: VDI_FORMAT_VHD
      })
    }

    return vdiId
  }

  async _legacyImportDeltaVmBackup (xapi, { remoteId, handler, filePath, info, sr }) {
    // Import vm metadata.
    const vm = await (async () => {
      const stream = await handler.createReadStream(`${filePath}.xva`)
      return /* await */ xapi.importVm(stream, { onlyMetadata: true })
    })()

    const vmName = vm.name_label
    const dir = dirname(filePath)

    // Disable start and change the VM name label during import.
    await Promise.all([
      xapi.addForbiddenOperationToVm(vm.$id, 'start', 'Delta backup import...'),
      xapi._setObjectProperties(vm, { name_label: `[Importing...] ${vmName}` })
    ])

    // Destroy vbds if necessary. Why ?
    // Because XenServer creates Vbds linked to the vdis of the backup vm if it exists.
    await xapi.destroyVbdsFromVm(vm.uuid)

    // Import VDIs.
    const vdiIds = {}
    await Promise.all(
      mapToArray(
        info.vdis,
        async vdiInfo => {
          vdiInfo.sr = sr._xapiId

          const vdiId = await this._legacyImportDeltaVdiBackup(xapi, { vmId: vm.$id, handler, dir, vdiInfo })
          vdiIds[vdiInfo.uuid] = vdiId
        }
      )
    )

    await Promise.all(
      mapToArray(
        info.vbds,
        vbdInfo => {
          xapi.attachVdiToVm(vdiIds[vbdInfo.xoVdi], vm.$id, vbdInfo)
        }
      )
    )

    // Import done, reenable start and set real vm name.
    await Promise.all([
      xapi.removeForbiddenOperationFromVm(vm.$id, 'start'),
      xapi._setObjectProperties(vm, { name_label: vmName })
    ])

    return vm
  }

  // -----------------------------------------------------------------

  async _listVdiBackups (handler, dir) {
    let files

    try {
      files = await handler.list(dir)
    } catch (error) {
      if (error.code === 'ENOENT') {
        files = []
      } else {
        throw error
      }
    }

    const backups = sortBy(filter(files, fileName => isVdiBackup(fileName)))
    let i

    // Avoid unstable state: No full vdi found to the beginning of array. (base)
    for (i = 0; i < backups.length && isDeltaVdiBackup(backups[i]); i++);
    await this._removeOldBackups(backups, handler, dir, i)

    return backups.slice(i)
  }

  async _deltaVdiBackup (xapi, {vdi, handler, dir, depth}) {
    const backupDirectory = `vdi_${vdi.uuid}`

    dir = `${dir}/${backupDirectory}`

    const backups = await this._listVdiBackups(handler, dir)

    // Make snapshot.
    const date = safeDateFormat(new Date())
    const currentSnapshot = await xapi.snapshotVdi(vdi.$id, 'XO_DELTA_BASE_VDI_SNAPSHOT')

    const bases = sortBy(
      filter(vdi.$snapshots, { name_label: 'XO_DELTA_BASE_VDI_SNAPSHOT' }),
      base => base.snapshot_time
    )

    const base = bases.pop()

    // Remove old bases if exists.
    Promise.all(mapToArray(bases, base => xapi.deleteVdi(base.$id)))::pCatch(noop)

    // It is strange to have no base but a full backup !
    // A full is necessary if it not exists backups or
    // the base is missing.
    const isFull = (!backups.length || !base)

    // Export full or delta backup.
    const vdiFilename = `${date}_${isFull ? 'full' : 'delta'}.vhd`
    const backupFullPath = `${dir}/${vdiFilename}`

    try {
      const sourceStream = await xapi.exportVdi(currentSnapshot.$id, {
        baseId: isFull ? undefined : base.$id,
        format: VDI_FORMAT_VHD
      })

      const targetStream = await handler.createOutputStream(backupFullPath, {
        // FIXME: Checksum is not computed for full vdi backups.
        // The problem is in the merge case, a delta merged in a full vdi
        // backup forces us to browse the resulting file =>
        // Significant transfer time on the network !
        checksum: !isFull,
        flags: 'wx'
      })

      sourceStream.on('error', error => targetStream.emit('error', error))

      await Promise.all([
        eventToPromise(sourceStream.pipe(targetStream), 'finish'),
        sourceStream.task
      ])
    } catch (error) {
      // Remove new backup. (corrupt) and delete new vdi base.
      xapi.deleteVdi(currentSnapshot.$id)::pCatch(noop)
      await handler.unlink(backupFullPath, { checksum: true })::pCatch(noop)

      throw error
    }

    // Returns relative path. (subdir and vdi filename), old/new base.
    return {
      backupDirectory,
      vdiFilename,
      oldBaseId: base && base.$id, // Base can be undefined. (full backup)
      newBaseId: currentSnapshot.$id
    }
  }

  async _mergeDeltaVdiBackups ({handler, dir, depth}) {
    const backups = await this._listVdiBackups(handler, dir)
    let i = backups.length - depth

    // No merge.
    if (i <= 0) {
      return
    }

    const timestamp = getVdiTimestamp(backups[i])
    const newFullBackup = `${dir}/${timestamp}_full.vhd`

    await checkFileIntegrity(handler, `${dir}/${backups[i]}`)

    let j = i
    for (; j > 0 && isDeltaVdiBackup(backups[j]); j--);
    const fullBackupId = j

    // Remove old backups before the most recent full.
    if (j > 0) {
      for (j--; j >= 0; j--) {
        await handler.unlink(`${dir}/${backups[j]}`, { checksum: true })
      }
    }

    const parent = `${dir}/${backups[fullBackupId]}`
    const path = handler._remote.path // FIXME, private attribute !

    for (j = fullBackupId + 1; j <= i; j++) {
      const backup = `${dir}/${backups[j]}`

      try {
        await checkFileIntegrity(handler, backup)
        await vhdMerge(handler, `${path}/${parent}`, handler, `${path}/${backup}`)
      } catch (e) {
        console.error('Unable to use vhd-util.', e)
        throw e
      }

      await handler.unlink(backup, { checksum: true })
    }

    // Rename the first old full backup to the new full backup.
    await handler.rename(parent, newFullBackup)
  }

  async _listDeltaVdiDependencies (handler, filePath) {
    const dir = dirname(filePath)
    const filename = basename(filePath)
    const backups = await this._listVdiBackups(handler, dir)

    // Search file. (delta or full backup)
    const i = findIndex(backups, backup =>
      getVdiTimestamp(backup) === getVdiTimestamp(filename)
    )

    if (i === -1) {
      throw new Error('VDI to import not found in this remote.')
    }

    // Search full backup.
    let j

    for (j = i; j >= 0 && isDeltaVdiBackup(backups[j]); j--);

    if (j === -1) {
      throw new Error(`Unable to found full vdi backup of: ${filePath}`)
    }

    return backups.slice(j, i + 1)
  }

  // -----------------------------------------------------------------

  async _listDeltaVmBackups (handler, dir) {
    const files = await handler.list(dir)
    return /* await */ sortBy(filter(files, isDeltaBackup))
  }

  async _failedRollingDeltaVmBackup (xapi, handler, dir, fulFilledVdiBackups) {
    await Promise.all(
      mapToArray(fulFilledVdiBackups, async vdiBackup => {
        const { newBaseId, backupDirectory, vdiFilename } = vdiBackup.value()

        await xapi.deleteVdi(newBaseId)
        await handler.unlink(`${dir}/${backupDirectory}/${vdiFilename}`, { checksum: true })::pCatch(noop)
      })
    )
  }

  async rollingDeltaVmBackup ({vm, remoteId, tag, depth}) {
    const remote = await this._xo.getRemote(remoteId)

    if (!remote) {
      throw new Error(`No such Remote ${remoteId}`)
    }
    if (!remote.enabled) {
      throw new Error(`Remote ${remoteId} is disabled`)
    }

    const handler = await this._xo.getRemoteHandler(remote)
    const dir = `vm_delta_${tag}_${vm.uuid}`

    const info = {
      version: '1.0.0',
      vbds: {},
      vdis: {},
      vifs: {}
    }

    const promises = []
    const xapi = this._xo.getXapi(vm)

    vm = xapi.getObject(vm._xapiId)

    for (const vbd of vm.$VBDs) {
      const vdiId = vbd.VDI

      if (!vdiId || vbd.type !== 'Disk') {
        continue
      }

      info.vbds[vbd.$ref] = vbd

      // Warning: There may be the same VDI id for a VBD set.
      if (info.vdis[vdiId]) {
        continue
      }

      const vdi = vbd.$VDI

      info.vdis[vdiId] = { ...vdi }
      promises.push(
        this._deltaVdiBackup(xapi, {vdi, handler, dir, depth}).then(
          vdiBackup => {
            const { backupDirectory, vdiFilename } = vdiBackup
            info.vdis[vdiId].xoPath = `${backupDirectory}/${vdiFilename}`

            return vdiBackup
          }
        )
      )
    }

    const vdiBackups = await pSettle(promises)
    const fulFilledVdiBackups = []
    let fail = false

    // One or many vdi backups have failed.
    for (const vdiBackup of vdiBackups) {
      if (vdiBackup.isFulfilled()) {
        fulFilledVdiBackups.push(vdiBackup)
      } else {
        console.error(`Rejected backup: ${vdiBackup.reason()}`)
        fail = true
      }
    }

    if (fail) {
      console.error(`Remove successful backups in ${dir}`, fulFilledVdiBackups)
      await this._failedRollingDeltaVmBackup(xapi, handler, dir, fulFilledVdiBackups)

      throw new Error('Rolling delta vm backup failed.')
    }

    const date = safeDateFormat(new Date())
    const backupFormat = `${date}_${vm.name_label}`
    const infoPath = `${dir}/${backupFormat}${DELTA_BACKUP_EXT}`

    try {
      for (const vif of vm.$VIFs) {
        info.vifs[vif.$ref] = vif
      }

      info.vm = vm

      await handler.outputFile(infoPath, JSON.stringify(info, null, 2), {flag: 'wx'})
    } catch (e) {
      await Promise.all([
        handler.unlink(infoPath)::pCatch(noop),
        this._failedRollingDeltaVmBackup(xapi, handler, dir, fulFilledVdiBackups)
      ])

      throw e
    }

    // Here we have a completed backup. We can merge old vdis.
    await Promise.all(
      mapToArray(vdiBackups, vdiBackup => {
        const { backupDirectory } = vdiBackup.value()
        return this._mergeDeltaVdiBackups({handler, dir: `${dir}/${backupDirectory}`, depth})
      })
    )

    // Remove old vm backups.
    const backups = await this._listDeltaVmBackups(handler, dir)
    const nOldBackups = backups.length - depth

    if (nOldBackups > 0) {
      await Promise.all(
        mapToArray(backups.slice(0, nOldBackups), async backup => {
          // Remove json file.
          await handler.unlink(`${dir}/${backup}`)

          // Remove xva file.
          // Version 0.0.0 (Legacy) Delta Backup.
          handler.unlink(`${dir}/${getDeltaBackupNameWithoutExt(backup)}.xva`)::pCatch(noop)
        })
      )
    }

    // Remove old vdi bases.
    Promise.all(
      mapToArray(vdiBackups, async vdiBackup => {
        const { oldBaseId } = vdiBackup.value()

        if (oldBaseId) {
          await xapi.deleteVdi(oldBaseId)
        }
      })
    )::pCatch(noop)

    // Returns relative path.
    return `${dir}/${backupFormat}`
  }

  async importDeltaVmBackup ({sr, remoteId, filePath}) {
    const handler = await this._xo.getRemoteHandler(remoteId)
    const xapi = this._xo.getXapi(sr)

    const delta = JSON.parse(await handler.readFile(`${filePath}${DELTA_BACKUP_EXT}`))
    let vm
    const { version } = delta

    if (!version) {
      // Legacy import. (Version 0.0.0)
      vm = await this._legacyImportDeltaVmBackup(xapi, {
        remoteId, handler, filePath, info: delta, sr
      })
    } else if (versionSatisfies(delta.version, '^1')) {
      const basePath = dirname(filePath)
      const streams = delta.streams = {}

      await Promise.all(
        mapToArray(
          delta.vdis,
          async (vdi, id) => {
            const vdisFolder = `${basePath}/${dirname(vdi.xoPath)}`
            const backups = await this._listDeltaVdiDependencies(handler, `${basePath}/${vdi.xoPath}`)

            streams[`${id}.vhd`] = await Promise.all(mapToArray(backups, async backup =>
              handler.createReadStream(`${vdisFolder}/${backup}`, { checksum: true, ignoreMissingChecksum: true })
            ))
          }
        )
      )

      vm = await xapi.importDeltaVm(delta, {
        srId: sr._xapiId,
        disableStartAfterImport: false
      })
    } else {
      throw new Error(`Unsupported delta backup version: ${version}`)
    }

    return xapiObjectToXo(vm).id
  }

  // -----------------------------------------------------------------

  async backupVm ({vm, remoteId, file, compress, onlyMetadata}) {
    const remote = await this._xo.getRemote(remoteId)

    if (!remote) {
      throw new Error(`No such Remote ${remoteId}`)
    }
    if (!remote.enabled) {
      throw new Error(`Backup remote ${remoteId} is disabled`)
    }

    const handler = await this._xo.getRemoteHandler(remote)
    return this._backupVm(vm, handler, file, {compress, onlyMetadata})
  }

  async _backupVm (vm, handler, file, {compress, onlyMetadata}) {
    const targetStream = await handler.createOutputStream(file, { flags: 'wx' })
    const promise = eventToPromise(targetStream, 'finish')

    const sourceStream = await this._xo.getXapi(vm).exportVm(vm._xapiId, {
      compress,
      onlyMetadata: onlyMetadata || false
    })
    sourceStream.pipe(targetStream)

    await promise
  }

  async rollingBackupVm ({vm, remoteId, tag, depth, compress, onlyMetadata}) {
    const remote = await this._xo.getRemote(remoteId)

    if (!remote) {
      throw new Error(`No such Remote ${remoteId}`)
    }
    if (!remote.enabled) {
      throw new Error(`Backup remote ${remoteId} is disabled`)
    }

    const handler = await this._xo.getRemoteHandler(remote)

    const files = await handler.list()

    const reg = new RegExp('^[^_]+_' + escapeStringRegexp(`${tag}_${vm.name_label}.xva`))
    const backups = sortBy(filter(files, (fileName) => reg.test(fileName)))

    const date = safeDateFormat(new Date())
    const file = `${date}_${tag}_${vm.name_label}.xva`

    await this._backupVm(vm, handler, file, {compress, onlyMetadata})
    await this._removeOldBackups(backups, handler, undefined, backups.length - (depth - 1))
  }

  async rollingSnapshotVm (vm, tag, depth) {
    const xapi = this._xo.getXapi(vm)
    vm = xapi.getObject(vm._xapiId)

    const reg = new RegExp('^rollingSnapshot_[^_]+_' + escapeStringRegexp(tag) + '_')
    const snapshots = sortBy(filter(vm.$snapshots, snapshot => reg.test(snapshot.name_label)), 'name_label')
    const date = safeDateFormat(new Date())

    await xapi.snapshotVm(vm.$id, `rollingSnapshot_${date}_${tag}_${vm.name_label}`)

    const promises = []
    for (let surplus = snapshots.length - (depth - 1); surplus > 0; surplus--) {
      const oldSnap = snapshots.shift()
      promises.push(xapi.deleteVm(oldSnap.uuid, true))
    }
    await Promise.all(promises)
  }

  async rollingDrCopyVm ({vm, sr, tag, depth}) {
    tag = 'DR_' + tag
    const reg = new RegExp('^' + escapeStringRegexp(`${vm.name_label}_${tag}_`) + '[0-9]{8}T[0-9]{6}Z$')

    const targetXapi = this._xo.getXapi(sr)
    sr = targetXapi.getObject(sr._xapiId)
    const sourceXapi = this._xo.getXapi(vm)
    vm = sourceXapi.getObject(vm._xapiId)

    const vms = []
    forEach(sr.$VDIs, vdi => {
      const vbds = vdi.$VBDs
      const vm = vbds && vbds[0] && vbds[0].$VM
      if (vm && reg.test(vm.name_label)) {
        vms.push(vm)
      }
    })
    const olderCopies = sortBy(vms, 'name_label')

    const copyName = `${vm.name_label}_${tag}_${safeDateFormat(new Date())}`
    const drCopy = await sourceXapi.remoteCopyVm(vm.$id, targetXapi, sr.$id, {
      nameLabel: copyName
    })
    await targetXapi.addTag(drCopy.$id, 'Disaster Recovery')

    const promises = []
    for (let surplus = olderCopies.length - (depth - 1); surplus > 0; surplus--) {
      const oldDRVm = olderCopies.shift()
      promises.push(targetXapi.deleteVm(oldDRVm.$id, true))
    }
    await Promise.all(promises)
  }
}