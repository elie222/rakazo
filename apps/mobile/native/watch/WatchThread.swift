import Foundation

struct WatchThread: Decodable {
  struct Run: Decodable {
    let id: String
    let userId: String
    let status: String
  }

  struct Message: Decodable {
    struct Block: Decodable {
      let kind: String
      let text: String?
      let status: String?
      let input: String?
      let detail: String?
      let detailFormat: String?
      let actions: [WatchPrompt.Option]?
      let approvalEffectId: String?
      // These cards need the full review UI on iPhone.
      let requiresPhone: Bool

      private enum CodingKeys: String, CodingKey {
        case kind, text, status, input, detail, detailFormat, actions, approvalEffectId
        case receipt, instructionUpdate, settingsUpdate, credential, oneTimeCode, loginFields
      }

      init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        text = try values.decodeIfPresent(String.self, forKey: .text)
        status = try values.decodeIfPresent(String.self, forKey: .status)
        input = try values.decodeIfPresent(String.self, forKey: .input)
        detail = try values.decodeIfPresent(String.self, forKey: .detail)
        detailFormat = try values.decodeIfPresent(String.self, forKey: .detailFormat)
        actions = try values.decodeIfPresent([WatchPrompt.Option].self, forKey: .actions)
        approvalEffectId = try values.decodeIfPresent(String.self, forKey: .approvalEffectId)
        requiresPhone = [
          .receipt, .instructionUpdate, .settingsUpdate, .credential, .oneTimeCode, .loginFields,
        ].contains { values.contains($0) }
      }

      func watchPrompt() -> WatchPrompt {
        let title = text ?? ""
        let options = actions ?? []
        let ids = Set(options.map(\.id))
        // Keep full approval context on the wrist or direct the reviewer to the phone.
        let handoff = WatchPrompt(kind: .phone, title: "", detail: nil, options: [])
        guard !requiresPhone, input == nil || input == "text", options.count <= 12,
          options.count == ids.count
        else { return handoff }
        let prompt: WatchPrompt
        if let approvalEffectId {
          // Approval cards use an ellipsis when they shorten a title, detail or batch item.
          // Send code and any review that may omit context to the iPhone.
          guard !title.isEmpty, !title.contains("…"),
            let detail, !detail.isEmpty, !detail.contains("…"), detailFormat != "code",
            ids.contains("allow"), ids.contains("deny"), ids.isSubset(of: ["allow", "deny", "always"])
          else { return handoff }
          prompt = WatchPrompt(
            kind: .approval, title: title.replacingOccurrences(
              of: #"\\([\\`*_\[\]<>~|])"#, with: "$1", options: .regularExpression),
            detail: detail,
            options: options.filter { $0.id == "allow" || $0.id == "deny" },
            approvalEffectId: approvalEffectId)
        } else {
          prompt = WatchPrompt(kind: .question, title: title, detail: detail, options: options)
        }
        guard let data = try? JSONEncoder().encode(prompt), data.count <= 8_192 else { return handoff }
        return prompt
      }
    }

    let id: String
    let role: String
    let runId: String?
    let blocks: [Block]

    var pendingAsk: Block? {
      guard role == "bot" else { return nil }
      return blocks.first { $0.kind == "ask" && $0.status != "answered" }
    }

    var hasPhoneOnlyCard: Bool {
      role == "bot" && blocks.contains {
        ($0.kind == "mcp_approval" && ($0.status == nil || $0.status == "pending"))
          || ($0.kind == "tool_question" && $0.status == "pending")
      }
    }

    var watchText: String {
      blocks.compactMap { block in
        if block.kind == "text" { return block.text }
        if block.kind == "ask", block.status == "answered", block.input != "secret" {
          return block.text
        }
        return nil
      }.joined(separator: "\n\n")
    }
  }

  let messages: [Message]
  let activeRuns: [Run]?

  func ownsPendingAsk(_ message: Message, userId: String) -> Bool {
    activeRuns?.contains {
      $0.id == message.runId && $0.userId == userId && $0.status == "waiting_input"
    } == true
  }

  func watchMessages(for userId: String) -> [WatchMessage] {
    let visible = messages.compactMap { message -> WatchMessage? in
      let text = message.watchText
      let ask = ownsPendingAsk(message, userId: userId) ? message.pendingAsk?.watchPrompt() : nil
      let handoff = WatchPrompt(kind: .phone, title: "", detail: nil, options: [])
      let ownsRun = activeRuns?.contains { $0.id == message.runId && $0.userId == userId } == true
      let prompt = ask ?? (ownsRun && message.hasPhoneOnlyCard ? handoff : nil)
      guard !text.isEmpty || prompt != nil else { return nil }
      return WatchMessage(
        id: message.id, fromUser: message.role == "user",
        text: text.count > 1000 ? String(text.prefix(999)) + "…" : text, prompt: prompt)
    }
    // Keep pending cards before filling the remaining transfer budget with recent messages.
    let candidates = visible.reversed().filter { $0.prompt != nil }
      + visible.suffix(16).reversed().filter { $0.prompt == nil }
    var budget = 40_000
    var selected = Set<String>()
    let encoder = JSONEncoder()
    for message in candidates {
      guard let data = try? encoder.encode(message), data.count + 1 <= budget else { continue }
      budget -= data.count + 1
      selected.insert(message.id)
    }
    return visible.filter { selected.contains($0.id) }
  }
}
