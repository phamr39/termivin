// Data the relay forwards from a Termivin desktop. Shapes follow
// docs/REMOTE.md and src/remote/index.js (snapshot / attention / chat).

T? _as<T>(Object? v) => v is T ? v : null;
String _s(Object? v, [String d = '']) => v is String ? v : d;
int _i(Object? v, [int d = 0]) => v is int ? v : (v is num ? v.toInt() : d);

class HostInfo {
  HostInfo({required this.id, required this.name, required this.online, this.lastSeen, this.scopes = const []});
  final String id;
  String name;
  bool online;
  int? lastSeen;
  List<String> scopes;

  bool can(String scope) => scopes.contains(scope);

  factory HostInfo.fromJson(Map<String, dynamic> j) => HostInfo(
        id: _s(j['hostId']),
        name: _s(j['name'], 'PC'),
        online: j['online'] == true,
        lastSeen: _as<int>(j['lastSeen']),
        scopes: (_as<List>(j['scopes']) ?? const []).map((e) => e.toString()).toList(),
      );
}

class TermInfo {
  TermInfo({
    required this.id,
    required this.name,
    required this.type,
    required this.status,
    this.cwd = '',
    this.summary = '',
    this.external = false,
    this.dockGroup,
    this.permissionMode = '',
    this.restoreCommand = '',
    this.pendingMail = 0,
    this.exitCode,
  });
  final String id;
  final String name;
  final String type;
  final String status; // working | idle | approval | exited | saved | attached
  final String cwd;
  final String summary;
  final bool external;
  final String? dockGroup;
  final String permissionMode;
  final String restoreCommand;
  final int pendingMail;
  final int? exitCode;

  bool get running => status == 'working' || status == 'idle' || status == 'approval';
  bool get isAgent => type == 'claude' || type == 'codex' || type == 'custom';

  factory TermInfo.fromJson(Map<String, dynamic> j) => TermInfo(
        id: _s(j['id']),
        name: _s(j['name'], 'Terminal'),
        type: _s(j['type'], 'shell'),
        status: _s(j['status'], 'saved'),
        cwd: _s(j['cwd']),
        summary: _s(j['summary']),
        external: j['external'] == true,
        dockGroup: _as<String>(j['dockGroup']),
        permissionMode: _s(j['permissionMode']),
        restoreCommand: _s(j['restoreCommand']),
        pendingMail: _i(j['pendingMail']),
        exitCode: _as<int>(j['exitCode']),
      );
}

class WorkspaceInfo {
  WorkspaceInfo({required this.id, required this.name, required this.terminals});
  final String id;
  final String name;
  final List<TermInfo> terminals;

  factory WorkspaceInfo.fromJson(Map<String, dynamic> j) => WorkspaceInfo(
        id: _s(j['id']),
        name: _s(j['name'], 'Workspace'),
        terminals: (_as<List>(j['terminals']) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(TermInfo.fromJson)
            .toList(),
      );
}

class Snapshot {
  Snapshot({required this.workspaces, required this.topics, this.activeWorkspaceId, this.stale = false});
  final List<WorkspaceInfo> workspaces;
  final List<Map<String, dynamic>> topics;
  final String? activeWorkspaceId;
  bool stale;

  factory Snapshot.fromJson(Map<String, dynamic> j, {bool stale = false}) => Snapshot(
        workspaces: (_as<List>(j['workspaces']) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(WorkspaceInfo.fromJson)
            .toList(),
        topics: (_as<List>(j['topics']) ?? const []).whereType<Map<String, dynamic>>().toList(),
        activeWorkspaceId: _as<String>(j['activeWorkspaceId']),
        stale: stale,
      );

  Iterable<({WorkspaceInfo ws, TermInfo term})> get allTerminals sync* {
    for (final ws in workspaces) {
      for (final t in ws.terminals) {
        yield (ws: ws, term: t);
      }
    }
  }

  ({WorkspaceInfo ws, TermInfo term})? find(String termId) {
    for (final x in allTerminals) {
      if (x.term.id == termId) return x;
    }
    return null;
  }
}

class PromptOption {
  PromptOption(this.key, this.label);
  final String key;
  final String label;
}

class AttentionItem {
  AttentionItem({
    required this.id,
    required this.kind,
    required this.title,
    this.termId,
    this.spaceId,
    this.excerpt = '',
    this.question = '',
    this.options = const [],
    this.screenHash,
    this.since,
  });
  final String id;
  final String kind; // approval | ask | exited
  final String title;
  final String? termId;
  final String? spaceId;
  final String excerpt;
  final String question;
  final List<PromptOption> options;
  final String? screenHash;
  final int? since;

  factory AttentionItem.fromJson(Map<String, dynamic> j) => AttentionItem(
        id: _s(j['id']),
        kind: _s(j['kind']),
        title: _s(j['title']),
        termId: _as<String>(j['termId']),
        spaceId: _as<String>(j['spaceId']),
        excerpt: _s(j['excerpt']),
        question: _s(j['question']),
        options: (_as<List>(j['options']) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map((o) => PromptOption(_s(o['key']), _s(o['label'])))
            .toList(),
        screenHash: _as<String>(j['screenHash']),
        since: _as<int>(j['since']),
      );
}

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.ts,
    required this.role,
    required this.kind,
    required this.text,
    this.from,
    this.fromName,
    this.toName,
    this.topic,
    this.subject = '',
    this.via,
    this.state,
  });
  final String id;
  final int ts;
  final String role; // owner | agent | desktop | system
  final String kind; // text | tool | bus | system
  final String text;
  final String? from;
  final String? fromName;
  final String? toName;
  final String? topic;
  final String subject;
  final String? via;
  String? state; // queued | delivered

  bool get mine => role == 'owner';

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: _s(j['id']),
        ts: _i(j['ts'], DateTime.now().millisecondsSinceEpoch),
        role: _s(j['role'], 'agent'),
        kind: _s(j['kind'], 'text'),
        text: _s(j['text']),
        from: _as<String>(j['from']),
        fromName: _as<String>(j['fromName']),
        toName: _as<String>(j['toName']),
        topic: _as<String>(j['topic']),
        subject: _s(j['subject']),
        via: _as<String>(j['via']),
        state: _as<String>(j['state']),
      );
}

class Conversation {
  Conversation({
    required this.conv,
    required this.kind,
    required this.title,
    required this.spaceId,
    this.spaceName = '',
    this.termId,
    this.type,
    this.status,
    this.members = const [],
    this.last,
    this.unread = 0,
  });
  final String conv;
  final String kind; // group | dm
  final String title;
  final String spaceId;
  final String spaceName;
  final String? termId;
  final String? type;
  final String? status;
  final List<Map<String, dynamic>> members;
  final ChatMessage? last;
  final int unread;

  factory Conversation.fromJson(Map<String, dynamic> j) => Conversation(
        conv: _s(j['conv']),
        kind: _s(j['kind'], 'dm'),
        title: _s(j['title']),
        spaceId: _s(j['spaceId']),
        spaceName: _s(j['spaceName']),
        termId: _as<String>(j['termId']),
        type: _as<String>(j['type']),
        status: _as<String>(j['status']),
        members: (_as<List>(j['members']) ?? const []).whereType<Map<String, dynamic>>().toList(),
        last: j['last'] is Map<String, dynamic> ? ChatMessage.fromJson(j['last'] as Map<String, dynamic>) : null,
        unread: _i(j['unread']),
      );
}

class ChatEvent {
  ChatEvent(this.hostId, this.conv, this.msg, {this.isUpdate = false});
  final String hostId;
  final String conv;
  final ChatMessage msg;
  final bool isUpdate;
}

class ScreenEvent {
  ScreenEvent(this.hostId, this.termId, this.seq, this.cols, this.rows, this.data, {this.stopped = false});
  final String hostId;
  final String termId;
  final int seq;
  final int cols;
  final int rows;
  final String data;
  final bool stopped;
}

class PtyFrame {
  PtyFrame(this.hostId, this.termId, this.seq, this.data);
  final String hostId;
  final String termId;
  final int seq;
  final String data;
}
