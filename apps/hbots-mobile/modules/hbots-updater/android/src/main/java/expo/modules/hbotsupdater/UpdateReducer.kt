package expo.modules.hbotsupdater

object UpdateReducer {
  const val INSTALL_COOLDOWN_MS = 30 * 60 * 1000L

  fun reduce(
    record: UpdateRecord,
    event: UpdateEvent,
    installedCode: Long,
    now: Long,
  ): Pair<UpdateRecord, List<UpdateEffect>> = when (event) {
    is UpdateEvent.Started -> started(record, event, installedCode, now)
    is UpdateEvent.Offered -> offered(record, event, installedCode, now, setLastCheckAt = true)
    is UpdateEvent.Downloaded -> downloaded(record, event)
    is UpdateEvent.Rejected -> rejected(record)
    UpdateEvent.DownloadFailed -> downloadFailed(record)
    UpdateEvent.IdleReached -> idleReached(record, now)
    UpdateEvent.UserConfirmed -> userConfirmed(record, now)
    UpdateEvent.InstallSucceeded -> installSucceeded(record)
    is UpdateEvent.InstallNeedsTap -> installNeedsTap(record)
    UpdateEvent.InstallFailed -> installFailed(record)
    UpdateEvent.InstallDeferred -> installDeferred(record)
    UpdateEvent.InstallNotPermitted -> installNotPermitted(record)
    UpdateEvent.WentBackground -> wentBackground(record)
    UpdateEvent.WentForeground -> record to listOf(UpdateEffect.CancelIdleInstall)
    UpdateEvent.SignedOut -> signedOut(record)
    is UpdateEvent.PermissionChanged -> permissionChanged(record, event, installedCode, now)
  }

  private fun started(
    record: UpdateRecord,
    event: UpdateEvent.Started,
    installedCode: Long,
    now: Long,
  ): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    val target = state.targetOrNull() ?: record.lastOffer
    if (target != null && installedCode > 0 && installedCode >= target.code) {
      val postUpdated = record.notifiedCode != installedCode
      val effects = buildList {
        add(UpdateEffect.CancelIdleInstall)
        if (state.ownsFile()) add(UpdateEffect.DeleteFile)
        if (postUpdated) add(UpdateEffect.PostUpdated)
      }
      return record.copy(
        state = UpdateState.Idle(),
        lastOffer = null,
        notifiedCode = if (postUpdated) installedCode else record.notifiedCode,
      ) to effects
    }

    return when (state) {
      is UpdateState.Downloading ->
        record.copy(state = UpdateState.Idle()) to
          listOf(UpdateEffect.CancelIdleInstall, UpdateEffect.DeleteFile)
      is UpdateState.Installing -> {
        val next = if (!event.pendingInstall || now - state.since > INSTALL_COOLDOWN_MS) {
          UpdateState.Ready(state.target, state.apk)
        } else {
          state
        }
        record.copy(state = next) to listOf(UpdateEffect.CancelIdleInstall)
      }
      is UpdateState.NeedsPermission -> {
        if (event.canInstall) {
          val (next, effects) = offered(
            record.copy(state = UpdateState.Idle()),
            UpdateEvent.Offered(record.lastOffer, authenticated = true, canInstall = true),
            installedCode,
            now,
            setLastCheckAt = false,
          )
          next to (listOf(UpdateEffect.CancelIdleInstall) + effects)
        } else {
          record to listOf(UpdateEffect.CancelIdleInstall)
        }
      }
      else -> record to listOf(UpdateEffect.CancelIdleInstall)
    }
  }

  private fun offered(
    record: UpdateRecord,
    event: UpdateEvent.Offered,
    installedCode: Long,
    now: Long,
    setLastCheckAt: Boolean,
  ): Pair<UpdateRecord, List<UpdateEffect>> {
    val base = if (event.manual) record.copy(state = record.state.withoutRejected()) else record
    val checked = if (setLastCheckAt) base.copy(lastCheckAt = now) else base
    val state = checked.state
    val release = event.release

    if (state is UpdateState.Installing) {
      return checked to emptyList()
    }

    if (release == null || release.code <= installedCode) {
      val effects = if (state.ownsFile()) listOf(UpdateEffect.DeleteFile) else emptyList()
      val rejected = (state as? UpdateState.Idle)?.rejected
      return checked.copy(state = UpdateState.Idle(rejected), lastOffer = null) to effects
    }

    if (!event.authenticated) {
      val effects = if (state.ownsFile()) listOf(UpdateEffect.DeleteFile) else emptyList()
      val rejected = (state as? UpdateState.Idle)?.rejected
      return checked.copy(state = UpdateState.Idle(rejected), lastOffer = release) to effects
    }

    val currentCode = state.targetOrNull()?.code
    if (currentCode != null && release.code <= currentCode) {
      return checked.copy(lastOffer = release) to emptyList()
    }

    val rejected = (state as? UpdateState.Idle)?.rejected
    val next = when {
      !event.canInstall -> UpdateState.NeedsPermission(release)
      release.sha256 == rejected?.sha256 -> UpdateState.Idle(rejected)
      else -> UpdateState.Downloading(release)
    }
    val delete = if (state.ownsFile()) listOf(UpdateEffect.DeleteFile) else emptyList()
    val effects = if (next is UpdateState.Downloading) {
      delete + UpdateEffect.StartDownload
    } else {
      delete
    }
    return checked.copy(state = next, lastOffer = release) to effects
  }

  private fun downloaded(
    record: UpdateRecord,
    event: UpdateEvent.Downloaded,
  ): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Downloading) return record to emptyList()
    val effects = if (event.inBackground) listOf(UpdateEffect.ScheduleIdleInstall) else emptyList()
    return record.copy(state = UpdateState.Ready(state.target, event.apk)) to effects
  }

  private fun rejected(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Downloading) return record to emptyList()
    return record.copy(state = UpdateState.Idle(rejected = state.target)) to
      listOf(UpdateEffect.DeleteFile)
  }

  private fun downloadFailed(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> {
    if (record.state !is UpdateState.Downloading) return record to emptyList()
    return record.copy(state = UpdateState.Idle()) to emptyList()
  }

  private fun idleReached(record: UpdateRecord, now: Long): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Ready) return record to emptyList()
    return record.copy(state = UpdateState.Installing(state.target, state.apk, now)) to
      listOf(UpdateEffect.CommitInstall)
  }

  private fun userConfirmed(record: UpdateRecord, now: Long): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    return when (state) {
      is UpdateState.Ready -> record.copy(state = UpdateState.Installing(state.target, state.apk, now)) to
        listOf(UpdateEffect.CommitInstall)
      is UpdateState.NeedsTap -> record.copy(state = UpdateState.Installing(state.target, state.apk, now)) to
        listOf(UpdateEffect.CommitInstall)
      else -> record to emptyList()
    }
  }

  private fun installSucceeded(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Installing) return record to emptyList()
    val code = state.target.code
    val postUpdated = record.notifiedCode != code
    val effects = buildList {
      add(UpdateEffect.DeleteFile)
      if (postUpdated) add(UpdateEffect.PostUpdated)
      add(UpdateEffect.ClearNotification)
    }
    return record.copy(
      state = UpdateState.Idle(),
      lastOffer = null,
      notifiedCode = if (postUpdated) code else record.notifiedCode,
    ) to effects
  }

  private fun installNeedsTap(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Installing) return record to emptyList()
    return record.copy(state = UpdateState.NeedsTap(state.target, state.apk)) to
      listOf(UpdateEffect.PostUpdateReady)
  }

  private fun installFailed(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Installing) return record to emptyList()
    return record.copy(state = UpdateState.Idle(rejected = state.target)) to
      listOf(UpdateEffect.DeleteFile, UpdateEffect.ClearNotification)
  }

  private fun installDeferred(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Installing) return record to emptyList()
    return record.copy(state = UpdateState.Ready(state.target, state.apk)) to emptyList()
  }

  private fun installNotPermitted(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> {
    val state = record.state
    if (state !is UpdateState.Installing) return record to emptyList()
    return record.copy(state = UpdateState.NeedsPermission(state.target)) to
      listOf(UpdateEffect.DeleteFile)
  }

  private fun signedOut(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> =
    UpdateRecord(
      state = UpdateState.Idle(),
      lastCheckAt = null,
      lastOffer = null,
      notifiedCode = record.notifiedCode,
    ) to listOf(
      UpdateEffect.CancelIdleInstall,
      UpdateEffect.DeleteAllFiles,
      UpdateEffect.ClearNotification,
    )

  private fun wentBackground(record: UpdateRecord): Pair<UpdateRecord, List<UpdateEffect>> =
    if (record.state is UpdateState.Ready) {
      record to listOf(UpdateEffect.ScheduleIdleInstall)
    } else {
      record to emptyList()
    }

  private fun permissionChanged(
    record: UpdateRecord,
    event: UpdateEvent.PermissionChanged,
    installedCode: Long,
    now: Long,
  ): Pair<UpdateRecord, List<UpdateEffect>> {
    if (!event.canInstall || record.state !is UpdateState.NeedsPermission) {
      return record to emptyList()
    }
    return offered(
      record.copy(state = UpdateState.Idle()),
      UpdateEvent.Offered(record.lastOffer, authenticated = true, canInstall = true),
      installedCode,
      now,
      setLastCheckAt = false,
    )
  }
}

private fun UpdateState.targetOrNull(): Release? = when (this) {
  is UpdateState.Idle -> null
  is UpdateState.Downloading -> target
  is UpdateState.Ready -> target
  is UpdateState.Installing -> target
  is UpdateState.NeedsTap -> target
  is UpdateState.NeedsPermission -> target
}

private fun UpdateState.ownsFile(): Boolean = when (this) {
  is UpdateState.Idle -> false
  is UpdateState.Downloading -> true
  is UpdateState.Ready -> true
  is UpdateState.Installing -> true
  is UpdateState.NeedsTap -> true
  is UpdateState.NeedsPermission -> false
}

private fun UpdateState.withoutRejected(): UpdateState =
  if (this is UpdateState.Idle) UpdateState.Idle() else this
