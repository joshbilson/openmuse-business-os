import AVFoundation
import CallKit
import ExpoModulesCore
import PushKit
import WebRTC

private struct VoiceDiagnostic: Codable {
  let timestamp: String
  let callId: String
  let stage: String
  let microphonePermission: String
  let audioActivated: Bool
}

private final class VoipCallCenter: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = VoipCallCenter()

  private static let diagnosticStages: Set<String> = [
    "native_push_received", "native_push_reported", "native_push_report_failed",
    "native_answer_action", "native_outgoing_action", "native_end_action",
    "native_end_requested", "native_end_completed", "native_end_failed",
    "native_audio_activated", "native_audio_deactivated", "native_provider_reset",
    "native_watchdog_started", "native_watchdog_expired", "native_call_connected",
    "js_answer_received", "js_answer_request", "js_answer_response",
    "js_audio_wait_start", "js_audio_wait_ready", "js_connect_error",
    "js_connect_finished", "js_mic_request", "js_mic_ready",
    "js_offer_started", "js_offer_ready", "js_ice_ready",
    "js_session_request", "js_session_response", "js_media_ready",
    "js_finish_started", "js_finish_complete",
  ]

  private let provider: CXProvider
  private let controller = CXCallController()
  private var registry: PKPushRegistry?
  private var callIds: [UUID: String] = [:]
  private var threads: [UUID: String] = [:]
  private var incoming: Set<UUID> = []
  private var watchdogs: [UUID: DispatchWorkItem] = [:]
  private var pending: [[String: Any]] = []
  private var token: String?
  private var audioActivated = false
  private var diagnostics: [VoiceDiagnostic] = []
  var observing = false
  var listener: (([String: Any]) -> Void)?

  override init() {
    let configuration = CXProviderConfiguration(localizedName: "OpenMuse")
    configuration.supportsVideo = false
    configuration.maximumCallsPerCallGroup = 1
    configuration.maximumCallGroups = 1
    configuration.supportedHandleTypes = [.generic]
    provider = CXProvider(configuration: configuration)
    super.init()
    provider.setDelegate(self, queue: .main)
    if let url = diagnosticsURL(),
       let data = try? Data(contentsOf: url), data.count <= 64_000,
       let saved = try? JSONDecoder().decode([VoiceDiagnostic].self, from: data) {
      diagnostics = Array(saved.suffix(64))
    }
  }

  private func diagnosticsURL() -> URL? {
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
    let directory = support.appendingPathComponent("OpenMuse", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    return directory.appendingPathComponent("voice-diagnostics.json")
  }

  func recordStage(_ stage: String, callId: String) {
    if !Thread.isMainThread {
      DispatchQueue.main.async { self.recordStage(stage, callId: callId) }
      return
    }
    guard Self.diagnosticStages.contains(stage), let uuid = UUID(uuidString: callId) else { return }
    let permission: String
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted: permission = "granted"
    case .denied: permission = "denied"
    case .undetermined: permission = "undetermined"
    @unknown default: permission = "unknown"
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    diagnostics.append(VoiceDiagnostic(
      timestamp: formatter.string(from: Date()),
      callId: uuid.uuidString.lowercased(),
      stage: stage,
      microphonePermission: permission,
      audioActivated: audioActivated
    ))
    if diagnostics.count > 64 { diagnostics.removeFirst(diagnostics.count - 64) }
    guard let url = diagnosticsURL(), let data = try? JSONEncoder().encode(diagnostics) else { return }
    try? data.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: url.path
    )
  }

  func start() {
    guard registry == nil else { return }
    let pushRegistry = PKPushRegistry(queue: .main)
    pushRegistry.delegate = self
    pushRegistry.desiredPushTypes = [.voIP]
    registry = pushRegistry
  }

  private func emit(_ event: [String: Any]) {
    if observing, let listener { listener(event) } else { pending.append(event) }
  }

  func drain() -> [[String: Any]] {
    let events = pending
    pending.removeAll()
    return events
  }

  func currentToken() -> String? { token }
  func isAudioActivated() -> Bool { audioActivated }

  private func details(_ uuid: UUID) -> [String: Any] {
    var result: [String: Any] = ["callId": callIds[uuid] ?? uuid.uuidString]
    if let threadId = threads[uuid] { result["threadId"] = threadId }
    return result
  }

  private func expectConnection(_ uuid: UUID) {
    recordStage("native_watchdog_started", callId: callIds[uuid] ?? uuid.uuidString)
    watchdogs[uuid]?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.callIds[uuid] != nil else { return }
      self.recordStage("native_watchdog_expired", callId: self.callIds[uuid] ?? uuid.uuidString)
      self.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
      self.emit(["type": "end"].merging(self.details(uuid)) { _, new in new })
      self.callIds.removeValue(forKey: uuid)
      self.threads.removeValue(forKey: uuid)
      self.incoming.remove(uuid)
      self.watchdogs.removeValue(forKey: uuid)
    }
    watchdogs[uuid] = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 40, execute: work)
  }

  private func uuid(for callId: String) -> UUID? {
    callIds.first(where: { $0.value == callId })?.key ?? UUID(uuidString: callId)
  }

  func startOutgoing(callId: String, displayName: String) async throws {
    let uuid = UUID(uuidString: callId) ?? UUID()
    callIds[uuid] = callId
    let handle = CXHandle(type: .generic, value: displayName)
    let action = CXStartCallAction(call: uuid, handle: handle)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      controller.request(CXTransaction(action: action)) { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
    }
  }

  func end(callId: String) async throws {
    guard let uuid = uuid(for: callId) else { return }
    recordStage("native_end_requested", callId: callId)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
        if let error {
          self.recordStage("native_end_failed", callId: callId)
          continuation.resume(throwing: error)
        } else {
          self.recordStage("native_end_completed", callId: callId)
          continuation.resume()
        }
      }
    }
  }

  func answer(callId: String) async throws {
    guard let uuid = uuid(for: callId) else { return }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      controller.request(CXTransaction(action: CXAnswerCallAction(call: uuid))) { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
    }
  }

  func mute(callId: String, muted: Bool) async throws {
    guard let uuid = uuid(for: callId) else { return }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
    }
  }

  func connected(callId: String) {
    guard let uuid = uuid(for: callId) else { return }
    recordStage("native_call_connected", callId: callId)
    watchdogs.removeValue(forKey: uuid)?.cancel()
    if !incoming.contains(uuid) { provider.reportOutgoingCall(with: uuid, connectedAt: Date()) }
  }

  func setSpeaker(_ enabled: Bool) throws {
    try AVAudioSession.sharedInstance().overrideOutputAudioPort(enabled ? .speaker : .none)
  }

  func selectBluetooth() throws {
    let session = AVAudioSession.sharedInstance()
    guard let port = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) else {
      throw NSError(domain: "VoipCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "No Bluetooth call device is connected."])
    }
    try session.overrideOutputAudioPort(.none)
    try session.setPreferredInput(port)
  }

  func hasBluetooth() -> Bool {
    AVAudioSession.sharedInstance().availableInputs?.contains(where: { $0.portType == .bluetoothHFP }) ?? false
  }

  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    self.token = token
    emit(["type": "token", "token": token])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    token = nil
    emit(["type": "tokenInvalidated"])
  }

  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    guard type == .voIP else { completion(); return }
    let data = payload.dictionaryPayload
    let callId = data["callId"] as? String ?? UUID().uuidString
    recordStage("native_push_received", callId: callId)
    let uuid = UUID(uuidString: callId) ?? UUID()
    let name = data["callerName"] as? String ?? "OpenMuse"
    callIds[uuid] = callId
    incoming.insert(uuid)
    if let threadId = data["threadId"] as? String { threads[uuid] = threadId }
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: data["handle"] as? String ?? name)
    update.localizedCallerName = name
    update.hasVideo = false
    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      defer { completion() }
      guard error == nil else {
        self?.recordStage("native_push_report_failed", callId: callId)
        self?.emit(["type": "callError", "callId": callId, "message": error!.localizedDescription])
        return
      }
      self?.recordStage("native_push_reported", callId: callId)
      var event: [String: Any] = ["type": "incoming", "callId": callId]
      if let threadId = data["threadId"] as? String { event["threadId"] = threadId }
      if let expiresAt = data["expiresAt"] { event["expiresAt"] = expiresAt }
      self?.emit(event)
    }
  }

  func providerDidReset(_ provider: CXProvider) {
    for callId in callIds.values { recordStage("native_provider_reset", callId: callId) }
    for work in watchdogs.values { work.cancel() }
    watchdogs.removeAll()
    for uuid in callIds.keys { emit(["type": "end"].merging(details(uuid)) { _, new in new }) }
    callIds.removeAll()
    threads.removeAll()
    incoming.removeAll()
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    recordStage("native_outgoing_action", callId: callIds[action.callUUID] ?? action.callUUID.uuidString)
    do {
      try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
      provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
      expectConnection(action.callUUID)
      emit(["type": "outgoingStarted"].merging(details(action.callUUID)) { _, new in new })
      action.fulfill()
    } catch { action.fail() }
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    recordStage("native_answer_action", callId: callIds[action.callUUID] ?? action.callUUID.uuidString)
    do {
      try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
      expectConnection(action.callUUID)
      emit(["type": "answer"].merging(details(action.callUUID)) { _, new in new })
      action.fulfill()
    } catch { action.fail() }
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    recordStage("native_end_action", callId: callIds[action.callUUID] ?? action.callUUID.uuidString)
    emit(["type": "end"].merging(details(action.callUUID)) { _, new in new })
    watchdogs.removeValue(forKey: action.callUUID)?.cancel()
    callIds.removeValue(forKey: action.callUUID)
    threads.removeValue(forKey: action.callUUID)
    incoming.remove(action.callUUID)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    emit(["type": "mute", "muted": action.isMuted].merging(details(action.callUUID)) { _, new in new })
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    audioActivated = true
    for callId in callIds.values { recordStage("native_audio_activated", callId: callId) }
    RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
    emit(["type": "audioActivated"])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    audioActivated = false
    for callId in callIds.values { recordStage("native_audio_deactivated", callId: callId) }
    RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
    emit(["type": "audioDeactivated"])
  }
}

public class VoipCallAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    VoipCallCenter.shared.start()
    return true
  }
}

public class VoipCallModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VoipCall")
    Events("onVoipEvent")

    OnCreate {
      VoipCallCenter.shared.listener = { [weak self] event in
        self?.sendEvent("onVoipEvent", event)
      }
      VoipCallCenter.shared.start()
    }
    OnStartObserving { VoipCallCenter.shared.observing = true }
    OnStopObserving { VoipCallCenter.shared.observing = false }
    OnDestroy {
      VoipCallCenter.shared.observing = false
      VoipCallCenter.shared.listener = nil
    }

    AsyncFunction("drainEvents") { () -> String in
      let events = VoipCallCenter.shared.drain()
      let data = try? JSONSerialization.data(withJSONObject: events)
      return data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }.runOnQueue(.main)

    AsyncFunction("getToken") { () -> String? in
      VoipCallCenter.shared.currentToken()
    }.runOnQueue(.main)

    AsyncFunction("isAudioActivated") { () -> Bool in
      VoipCallCenter.shared.isAudioActivated()
    }.runOnQueue(.main)

    AsyncFunction("recordStage") { (callId: String, stage: String) in
      VoipCallCenter.shared.recordStage(stage, callId: callId)
    }.runOnQueue(.main)

    AsyncFunction("startOutgoing") { (callId: String, displayName: String, promise: Promise) in
      Task { do { try await VoipCallCenter.shared.startOutgoing(callId: callId, displayName: displayName); promise.resolve() }
             catch { promise.reject(error) } }
    }.runOnQueue(.main)

    AsyncFunction("endCall") { (callId: String, promise: Promise) in
      Task { do { try await VoipCallCenter.shared.end(callId: callId); promise.resolve() }
             catch { promise.reject(error) } }
    }.runOnQueue(.main)

    AsyncFunction("answerCall") { (callId: String, promise: Promise) in
      Task { do { try await VoipCallCenter.shared.answer(callId: callId); promise.resolve() }
             catch { promise.reject(error) } }
    }.runOnQueue(.main)

    AsyncFunction("setMuted") { (callId: String, muted: Bool, promise: Promise) in
      Task { do { try await VoipCallCenter.shared.mute(callId: callId, muted: muted); promise.resolve() }
             catch { promise.reject(error) } }
    }.runOnQueue(.main)

    AsyncFunction("setSpeaker") { (enabled: Bool) throws in
      try VoipCallCenter.shared.setSpeaker(enabled)
    }.runOnQueue(.main)

    AsyncFunction("selectBluetooth") { () throws in
      try VoipCallCenter.shared.selectBluetooth()
    }.runOnQueue(.main)

    AsyncFunction("hasBluetooth") { () -> Bool in
      VoipCallCenter.shared.hasBluetooth()
    }.runOnQueue(.main)

    AsyncFunction("reportConnected") { (callId: String) in
      VoipCallCenter.shared.connected(callId: callId)
    }.runOnQueue(.main)
  }
}
