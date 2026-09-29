const status = document.querySelector("#status");
const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const toggle = document.querySelector("#toggle");
const connectionMessage = document.querySelector("#message");
const workspaceSelect = document.querySelector("#workspace-select");
const taskSelect = document.querySelector("#task-select");
const taskId = document.querySelector("#task-id");
const permissionSelect = document.querySelector("#permission-mode");
const taskCount = document.querySelector("#task-count");
const approvals = document.querySelector("#approvals");
const approvalCount = document.querySelector("#approval-count");
const history = document.querySelector("#history");
const upstreamConfig = document.querySelector("#upstream-config");
const upstreamStatus = document.querySelector("#upstream-status");
const upstreamMessage = document.querySelector("#upstream-message");
const tunnelStatus = document.querySelector("#tunnel-status");
const tunnelMessage = document.querySelector("#tunnel-message");
const tunnelLogs = document.querySelector("#tunnel-logs");
let appState = { workspacePath: "", mcpRunning: false, endpoint: "", accessToken: "" };
let workbench = { workspaces: [], tasks: [], pendingApprovals: [], defaultWorkspaceId: "", defaultTaskId: "" };
let renderedHistoryTask = "";
let renderedToolsTask = "";
const translations = {
  vi: { newTask: "Task mới", addWorkspace: "Thêm workspace", workspace: "Không gian làm việc", tasks: "Tác vụ", overview: "Tổng quan", files: "Tệp", changes: "Thay đổi", terminal: "Terminal", activity: "Hoạt động", connections: "Kết nối", settings: "Cài đặt", start: "Bật", stop: "Tắt", chat: "ChatGPT", copyId: "Sao chép ID", noTask: "Chưa chọn tác vụ", chooseWorkspace: "Chọn không gian làm việc", chooseOrCreate: "Chọn hoặc tạo tác vụ", ask: "Hỏi trước", auto: "Tự động", full: "Toàn quyền" },
  en: { newTask: "New task", addWorkspace: "Add workspace", workspace: "Workspace", tasks: "Tasks", overview: "Overview", files: "Files", changes: "Changes", terminal: "Terminal", activity: "Activity", connections: "Connections", settings: "Settings", start: "Start", stop: "Stop", chat: "ChatGPT", copyId: "Copy ID", noTask: "No task selected", chooseWorkspace: "Choose workspace", chooseOrCreate: "Choose or create a task", ask: "Ask", auto: "Auto", full: "Full" }
};
let language = localStorage.getItem("coworker.language") || "vi";
let chatVisible = false;
let nativeTourVisible = false;
let profileState = { profiles: [], activeProfileId: "" };
const languageText = key => translations[language][key] || translations.vi[key] || key;
const profileSelect = document.querySelector("#chat-profile-select");
function renderProfiles(state = profileState) {
  profileState = state;
  profileSelect.replaceChildren();
  for (const profile of state.profiles || []) {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.label; profileSelect.append(option);
  }
  profileSelect.value = state.activeProfileId || state.profiles?.[0]?.id || "";
}
const englishUi = new Map(Object.entries({
  "Task mới": "New task", "Thêm workspace": "Add workspace", "Workspace": "Workspace", "Tasks": "Tasks", "Chưa chọn": "Not selected", "Chưa có task": "No tasks", "Kết nối": "Connections", "Tổng quan": "Overview", "Tệp": "Files", "Thay đổi": "Changes", "Hoạt động": "Activity", "Cài đặt": "Settings", "Giao diện": "Appearance", "Ngôn ngữ": "Language", "Chủ đề": "Theme", "MCP đã tắt": "MCP is off", "MCP đã tắt.": "MCP is off.", "Bật": "Start", "Tắt": "Stop", "Bắt đầu với workspace": "Start with a workspace", "Chọn hoặc tạo task": "Choose or create a task", "Chưa chọn task": "No task selected", "Sao chép ID": "Copy ID", "Chờ duyệt": "Pending approvals", "Không có thao tác chờ duyệt.": "No actions waiting for approval.", "Yêu cầu phối hợp": "Task requests", "Chưa có yêu cầu phối hợp task.": "No task requests.", "Mở tệp": "Open files", "Tệp và editor": "Files and editor", "Xem thay đổi": "View changes", "Git status và diff": "Git status and diff", "Chạy lệnh": "Run command", "Terminal và jobs": "Terminal and jobs", "Terminal và tác vụ": "Terminal and jobs", "Lưu": "Save", "Làm mới": "Refresh", "Làm mới tác vụ": "Refresh jobs", "Lệnh": "Command", "Chạy nền": "Run in background", "Chạy": "Run", "Ghi nhớ dự án": "Project memory", "Khôi phục": "Restore", "Tải": "Load", "Xóa hết": "Clear all", "MCP server": "MCP server", "Secure MCP Tunnel": "Secure MCP Tunnel", "Bật tunnel": "Enable tunnel", "Duyệt": "Browse", "Trạng thái": "Status", "Đã lưu.": "Saved.", "Đã sao chép.": "Copied.", "Đang chạy": "Running", "Đã tắt": "Stopped", "Đã dừng": "Stopped", "Đang khởi động": "Starting", "Lỗi": "Error", "Không có upstream nào.": "No upstream servers.", "Chọn task để duyệt file.": "Choose a task to browse files.", "Chọn task để xem lịch sử.": "Choose a task to view history.", "Chọn task để đọc Git status.": "Choose a task to read Git status.", "Chưa tải diff.": "Diff not loaded.", "Chưa mở file": "No file open", "Chưa có checkpoint": "No checkpoints", "Không có yêu cầu mới.": "No new requests.", "Không có yêu cầu phối hợp task.": "No task requests.", "Tiếng Việt": "Vietnamese", "Theo máy": "System", "Sáng": "Light", "Tối": "Dark", "Duyệt": "Browse", "Mở": "Open", "Xong": "Done", "Tiếp tục": "Continue", "Ẩn tạm": "Hide for now", "Bỏ qua": "Skip", "Preview": "Preview", "Restore": "Restore", "Pull requests": "Pull requests", "Kiểm tra kết nối": "Check connection", "Issues": "Issues", "Checks": "Checks", "Tạo draft": "Create draft", "Xóa branch": "Delete branch", "Merge PR": "Merge PR", "Tiêu đề": "Title", "Mô tả": "Description", "JSON": "JSON", "Mở": "Open", "Chưa có checkpoint": "No checkpoints"
}));
Object.entries({
  "Bỏ qua điều hướng": "Skip navigation", "Chọn task để đọc Git status.": "Choose a task to view Git status.", "Chọn task để duyệt file.": "Choose a task to browse files.", "Chọn task để xem lịch sử.": "Choose a task to view activity.", "Chọn task và bật MCP để xem lịch sử.": "Choose a task and start MCP to view activity.", "Task này chưa có thao tác.": "This task has no activity yet.", "Task mới": "New task", "Ask": "Ask first", "Toàn quyền": "Full access", "Chọn workspace": "Choose a workspace", "Hỏi trước": "Ask first",
  "DUYỆT": "APPROVALS", "HỘP THƯ TASK": "TASK INBOX", "KHÔNG GIAN LÀM VIỆC": "WORKSPACE", "MÃ NGUỒN": "SOURCE CONTROL", "LỆNH": "COMMANDS", "TASK": "TASK", "MEMORY": "MEMORY", "CHECKPOINTS": "CHECKPOINTS", "SETTINGS": "SETTINGS", "CHATGPT WEB": "CHATGPT WEB",
  "Tạo task": "Create task", "Chọn hoặc tạo task": "Choose or create a task", "Chưa chọn task": "No task selected", "Không có thao tác chờ duyệt.": "No actions are waiting for approval.", "Không có yêu cầu mới.": "No new requests.", "Không có yêu cầu phối hợp task.": "No task requests.", "Chưa có yêu cầu phối hợp task.": "No task requests.", "Chưa có thao tác cần duyệt.": "No actions are waiting for approval.", "Chưa có checkpoint": "No checkpoints", "Chưa mở file": "No file open", "Chưa tải diff.": "Diff has not been loaded.", "Chưa mở workspace": "No workspace selected.",
  "Đã lưu.": "Saved.", "Đã sao chép.": "Copied.", "MCP đang chạy": "MCP is running", "MCP đã tắt": "MCP is off", "MCP đã tắt.": "MCP is off.", "Đã tắt": "Off", "Đang chạy": "Running", "Đang khởi động": "Starting", "Đã dừng": "Stopped", "Lỗi": "Error", "Không có upstream nào.": "No upstream servers configured.", "Chưa cấu hình upstream nào.": "No upstream servers configured.", "Đã lưu cấu hình upstream.": "Upstream configuration saved.", "Đang chạy tunnel-client…": "Starting tunnel-client…", "Tunnel đang chạy": "Tunnel is running",
  "Đường dẫn thư mục": "Folder path", "Nội dung file": "File contents", "Sao chép task ID": "Copy task ID", "Sao chép thông tin MCP": "Copy MCP connection details", "Mở hướng dẫn": "Open setup guide", "Làm mới": "Refresh", "Làm mới tác vụ": "Refresh jobs", "Làm mới jobs": "Refresh jobs", "Mở": "Open", "Duyệt": "Browse", "Lưu": "Save", "Tải": "Load", "Xóa hết": "Clear all", "Khôi phục": "Restore", "Bản xem trước": "Preview", "Từ chối": "Deny", "Cho phép lần này": "Allow once", "Cho phép": "Allow", "Bỏ qua": "Skip", "Tiếp tục": "Continue", "Ẩn tạm": "Hide for now", "Đóng": "Close", "Xong": "Done",
  "Lệnh": "Command", "Chạy lệnh": "Run command", "Chạy nền": "Run in background", "Chạy": "Run", "Ghi nhớ dự án": "Project memory", "Ngôn ngữ": "Language", "Giao diện": "Appearance", "Chủ đề": "Theme", "Tiếng Việt": "Vietnamese", "Theo máy": "System", "Sáng": "Light", "Tối": "Dark", "Runtime API key": "Runtime API key", "Đường dẫn executable": "Executable path", "Bật tunnel": "Enable tunnel", "Tạo draft": "Create draft", "Xóa branch": "Delete branch", "Kiểm tra kết nối": "Check connection", "Trạng thái": "Status", "Tiêu đề": "Title", "Mô tả": "Description", "Tìm issue": "Search issues", "Task mới": "New task", "Bắt đầu với workspace": "Start with a workspace", "Chọn workspace": "Choose a workspace", "Tệp và editor": "Files and editor", "Terminal và jobs": "Terminal and jobs", "Tổng quan": "Overview", "Tệp": "Files", "Thay đổi": "Changes", "Hoạt động": "Activity", "Kết nối": "Connections", "Cài đặt": "Settings", "Thêm workspace": "Add workspace", "Sao chép ID": "Copy ID", "Chờ duyệt": "Pending approvals", "Yêu cầu phối hợp": "Task requests", "Mở tệp": "Open files", "Xem thay đổi": "View changes", "Bật": "Start", "Tắt": "Stop"
}).forEach(([vietnamese, english]) => englishUi.set(vietnamese, english));
Object.entries({
  "Workspace": "Workspace", "Tasks": "Tasks", "ID": "ID", "Bước": "Step", "Bắt đầu với workspace": "Start with a workspace", "Task mới": "New task", "Tạo task": "Create task", "Ask": "Ask first", "Auto": "Automatic", "Full": "Full access", "All": "All", "Open": "Open", "Closed": "Closed", "Draft PR": "Draft PR", "Endpoint": "Endpoint", "Bearer token": "Bearer token", "Pull requests": "Pull requests", "Issues": "Issues", "Checks": "Checks", "Squash": "Squash", "Merge": "Merge", "Rebase": "Rebase", "Preview": "Preview", "Restore": "Restore", "Runtime API key": "Runtime API key", "tunnel-client": "tunnel-client", "stdio · HTTP · SSE": "stdio · HTTP · SSE", "COWORKER": "COWORKER", "TASK": "TASK", "GitHub": "GitHub", "JSON": "JSON", "UTF-8": "UTF-8", "Chưa chọn task": "No task selected", "Làm mới jobs": "Refresh jobs", "Chưa có background job.": "No background jobs.", "↑ parent": "↑ parent", "(empty directory)": "(empty directory)", "Copy prompt": "Copy prompt", "Log": "Log", "Stop": "Stop", "denied": "denied", "approved": "approved", "automatic": "automatic", "queued": "queued", "running": "running", "completed": "completed", "failed": "failed", "operation": "operation", "No project memory saved yet.": "No project memory saved yet.",
  "Mở workspace": "Open workspace", "Chưa chọn workspace": "No workspace selected", "Không có thao tác.": "No activity yet.", "Chọn task để xem hoạt động.": "Choose a task to view activity.", "MCP đang chạy": "MCP is running", "MCP đã tắt": "MCP is off", "MCP đang tắt": "MCP is off", "Đã tắt.": "Stopped.", "Đang chạy MCP": "MCP is running", "Không có task": "No tasks", "task": "task", "tasks": "tasks", "queued": "queued", "Không có tệp.": "No files.", "Đang tải…": "Loading…", "Đã lưu cấu hình upstream.": "Upstream configuration saved.", "Không có upstream nào được cấu hình.": "No upstream servers configured.", "Không có upstream server nào.": "No upstream servers.", "Chưa có ghi nhớ dự án.": "No project memory yet.", "Chưa có lịch sử.": "No activity yet.", "Đã xóa toàn bộ checkpoint.": "All checkpoints cleared.", "Không có kết nối MCP nào.": "No MCP connections.", "Thư mục rỗng": "Empty folder", "Thư mục cha": "Parent folder", "Chưa mở workspace": "No workspace selected", "Đang kết nối": "Connecting", "Đã kết nối": "Connected", "Không thể kết nối": "Unable to connect", "Cần bạn duyệt": "Approval needed", "Từ chối": "Deny", "Cho phép lần này": "Allow once", "Cho phép": "Allow", "Đóng ChatGPT": "Close ChatGPT", "Mở ChatGPT trong Coworker": "Open ChatGPT in Coworker", "Ẩn thanh bên": "Collapse sidebar", "Mở thanh bên": "Expand sidebar", "Sao chép thông tin MCP": "Copy MCP connection details", "Mở hướng dẫn": "Open setup guide", "Nội dung file": "File contents", "Đường dẫn thư mục": "Folder path", "Đường dẫn executable": "Executable path", "Bật Developer Mode": "Enable Developer Mode", "Runtime API key": "Runtime API key", "Tunnel ID": "Tunnel ID"
}).forEach(([vietnamese, english]) => englishUi.set(vietnamese, english));
Object.entries({
  "Điều hướng Coworker": "Coworker navigation", "Các mục": "Sections", "Quyền task": "Task permission",
  "Đăng nhập tự động": "Automatic sign-in", "Đăng nhập tự động các tài khoản ChatGPT": "Automatically sign in to ChatGPT accounts",
  "Đổi tên profile ChatGPT": "Rename ChatGPT profile", "Thêm profile ChatGPT": "Add ChatGPT profile", "Xóa profile ChatGPT": "Remove ChatGPT profile",
  "Đổi tên workspace": "Rename workspace", "Xóa workspace": "Remove workspace", "Đổi tên task": "Rename task", "Xóa task": "Delete task",
  "Tên (tài khoản)": "Name (account)", "VD: tài khoản chính": "E.g. primary account", "Ghi chú cho dự án": "Project notes",
  "Tạo handoff": "Create handoff", "Sao chép handoff": "Copy handoff", "Tìm issue": "Search issues", "Thu gọn thanh bên": "Collapse sidebar",
  "Đã sao chép handoff tiếp tục.": "Resume handoff copied.", "Không có thao tác cần duyệt.": "No actions waiting for approval.",
  "Đã lưu. Chưa có upstream nào.": "Saved. No upstream servers configured.", "Đã lưu cấu hình upstream.": "Upstream configuration saved.",
  "Không có yêu cầu phối hợp task.": "No task requests.", "Chưa có background job.": "No background jobs.",
  "Không mở được lớp hướng dẫn": "Could not open the setup guide", "Lỗi kết nối": "Connection error",
  "Xóa": "Remove", "Có": "Yes", "Không": "No", "Đổi tên": "Rename", "Gỡ khỏi app": "Remove from app", "Đóng tác vụ": "Close task",
  "Vui lòng bật MCP trước.": "Please start MCP first.",
  "Tự động bật MCP khi khởi động app": "Start MCP automatically when the app opens",
  "Mỗi Runtime API key chỉ dùng cho một tunnel. Dùng key riêng cho từng tài khoản.": "Each tunnel needs its own Runtime API key. Use a separate key for each account."
}).forEach(([vietnamese, english]) => englishUi.set(vietnamese, english));
const vietnameseUi = new Map();
for (const [vietnamese, english] of englishUi) if (english !== vietnamese && !vietnameseUi.has(english)) vietnameseUi.set(english, vietnamese);
for (const [english, vietnamese] of Object.entries({
  "MCP server": "Máy chủ MCP", "Upstream servers": "Máy chủ MCP ngoài", "Endpoint": "Địa chỉ kết nối", "Bearer token": "Token truy cập", "↑ parent": "↑ thư mục cha", "(empty directory)": "(thư mục trống)", "Copy prompt": "Sao chép lời nhắc", "Log": "Nhật ký", "Stop": "Dừng", "denied": "bị từ chối", "approved": "đã duyệt", "automatic": "tự động", "queued": "đang chờ", "running": "đang chạy", "completed": "hoàn tất", "failed": "thất bại", "operation": "thao tác", "No project memory saved yet.": "Chưa có ghi nhớ dự án.", "Open": "Mở", "Closed": "Đã đóng", "All": "Tất cả", "Draft PR": "PR nháp", "Ask": "Hỏi trước", "Auto": "Tự động", "Full": "Toàn quyền", "Preview": "Xem trước", "Restore": "Khôi phục", "Workspace": "Không gian làm việc", "Tasks": "Tác vụ", "task": "tác vụ", "tasks": "tác vụ", "English": "Tiếng Anh", "MEMORY": "GHI NHỚ", "CHECKPOINTS": "ĐIỂM KHÔI PHỤC", "SETTINGS": "CÀI ĐẶT", "TASK": "TÁC VỤ", "WORKSPACE": "KHÔNG GIAN LÀM VIỆC", "SOURCE CONTROL": "QUẢN LÝ MÃ NGUỒN", "COMMANDS": "LỆNH", "APPROVALS": "DUYỆT", "TASK INBOX": "HỘP THƯ TÁC VỤ", "Diff": "Bản khác biệt", "Open files": "Mở tệp", "Files and editor": "Tệp và trình sửa", "View changes": "Xem thay đổi", "Run command": "Chạy lệnh", "Task requests": "Yêu cầu tác vụ", "Pending approvals": "Thao tác chờ duyệt", "No new requests.": "Không có yêu cầu mới.", "No actions are waiting for approval.": "Không có thao tác chờ duyệt.", "Start": "Bật", "Stop": "Tắt", "Refresh": "Làm mới", "Save": "Lưu", "Browse": "Duyệt", "Loading…": "Đang tải…"
})) vietnameseUi.set(english, vietnamese);
for (const [english, vietnamese] of Object.entries({ "MEMORY": "GHI NHỚ", "CHECKPOINTS": "ĐIỂM KHÔI PHỤC", "SETTINGS": "CÀI ĐẶT", "TASK": "TÁC VỤ", "WORKSPACE": "KHÔNG GIAN LÀM VIỆC", "SOURCE CONTROL": "QUẢN LÝ MÃ NGUỒN", "COMMANDS": "LỆNH", "APPROVALS": "DUYỆT", "TASK INBOX": "HỘP THƯ TÁC VỤ", "Diff": "Khác biệt", "English": "Tiếng Anh" })) vietnameseUi.set(english, vietnamese);
// The Vietnamese view also translates English labels. Register that output in
// the opposite direction so switching back to English never strands a label.
for (const [english, vietnamese] of vietnameseUi) if (!englishUi.has(vietnamese)) englishUi.set(vietnamese, english);
function localizeDom() {
  const textMap = language === "en" ? englishUi : vietnameseUi;
  const translate = value => {
    const source = String(value).trim();
    const exact = textMap.get(source);
    if (exact) return exact;
    if (language === "en") {
      const running = source.match(/^(\d+)\/(\d+) đang chạy$/);
      if (running) return `${running[1]}/${running[2]} running`;
      const configured = source.match(/^(\d+) tunnel đã cấu hình\.$/);
      if (configured) return `${configured[1]} tunnel${configured[1] === "1" ? "" : "s"} configured.`;
      if (source.startsWith("Không mở được lớp hướng dẫn: ")) return source.replace("Không mở được lớp hướng dẫn: ", "Could not open the setup guide: ");
      const duplicateKey = "Mỗi Runtime API key chỉ dùng cho một tunnel. Dùng key riêng cho từng tài khoản.";
      if (source.includes(duplicateKey)) return source.replace(duplicateKey, englishUi.get(duplicateKey));
    } else {
      const running = source.match(/^(\d+)\/(\d+) running$/);
      if (running) return `${running[1]}/${running[2]} đang chạy`;
    }
    return undefined;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const value = node.nodeValue.trim();
    let replacement = translate(value);
    if (!replacement) {
      let count = value.match(/^(\d+) tasks?$/i);
      if (count) replacement = language === "en" ? `${count[1]} ${Number(count[1]) === 1 ? "task" : "tasks"}` : `${count[1]} tác vụ`;
      count = value.match(/^(\d+) queued$/i);
      if (count) replacement = language === "en" ? `${count[1]} queued` : `${count[1]} đang chờ`;
      const stepCount = value.match(/^(?:Bước|Step) (\d+\/\d+)$/);
      if (stepCount) replacement = language === "en" ? `Step ${stepCount[1]}` : `Bước ${stepCount[1]}`;
    }
    if (replacement && replacement !== value) node.nodeValue = node.nodeValue.replace(value, replacement);
  }
  document.querySelectorAll("[placeholder],[aria-label],[title]").forEach(node => {
    for (const attr of ["placeholder", "aria-label", "title"]) { const value = node.getAttribute(attr); if (!value) continue; const replacement = translate(value); if (replacement && replacement !== value) node.setAttribute(attr, replacement); }
  });
}
function localizeStatusText(element, value, isError = false) {
  const source = String(value || "");
  let translated = source;
  if (language === "en") {
    translated = englishUi.get(source) || source;
    const duplicateKey = "Mỗi Runtime API key chỉ dùng cho một tunnel. Dùng key riêng cho từng tài khoản.";
    if (source.includes(duplicateKey)) translated = source.replace(duplicateKey, englishUi.get(duplicateKey));
  }
  element.textContent = translated;
  element.classList.toggle("error", isError);
}
let localeObserverQueued = false;
const localeObserver = new MutationObserver(() => {
  if (localeObserverQueued) return;
  localeObserverQueued = true;
  queueMicrotask(() => { localeObserverQueued = false; localizeDom(); });
});
localeObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "aria-label", "title"] });
function applyLanguage() {
  document.documentElement.lang = language;
  void window.coworker.setUiLanguage(language);
  const map = { "#create-task span": "newTask", "#choose span": "addWorkspace", ".sidebar-section > span": "workspace", ".task-section .section-label-row > span": "tasks", ".nav-item[data-view='overview'] span": "overview", ".nav-item[data-view='files'] span": "files", ".nav-item[data-view='changes'] span": "changes", ".nav-item[data-view='terminal'] span": "terminal", ".nav-item[data-view='activity'] span": "activity", ".nav-item[data-view='connections'] span": "connections", ".nav-item[data-view='settings'] span": "settings", "#copy-task-overview": "copyId", "#toggle-chat span": "chat" };
  for (const [selector, key] of Object.entries(map)) { const node = document.querySelector(selector); if (node) node.textContent = languageText(key); }
  const english = language === "en";
  const texts = english ? {
    "#welcome-title": appState.workspacePath ? "Choose or create a task" : "Choose a workspace", "#overview-task-name": "No task selected",
    ".action-tile[data-open-view='files'] strong": "Open files", ".action-tile[data-open-view='files'] small": "Files and editor", ".action-tile[data-open-view='changes'] strong": "View changes", ".action-tile[data-open-view='changes'] small": "Git status and diff", ".action-tile[data-open-view='terminal'] strong": "Run command", ".action-tile[data-open-view='terminal'] small": "Terminal and jobs",
    ".approvals-card h3": "Pending approvals", ".approvals-card .empty-state": "No actions waiting for approval.", ".dispatch-card h3": "Task requests", ".dispatch-card .empty-state": "No task requests.",
    "#copy-task-overview": "Copy ID", "#view-files h1": "Files", "#view-files #save-file": "Save", "#view-changes h1": "Changes", "#view-terminal h1": "Terminal", "#view-activity h1": "Activity", "#view-connections h1": "Connections", "#view-settings h1": "Settings"
  } : {
    "#welcome-title": appState.workspacePath ? "Chọn hoặc tạo task" : "Chọn workspace", "#overview-task-name": "Chưa chọn task",
    ".action-tile[data-open-view='files'] strong": "Mở tệp", ".action-tile[data-open-view='files'] small": "Tệp và editor", ".action-tile[data-open-view='changes'] strong": "Xem thay đổi", ".action-tile[data-open-view='changes'] small": "Git status và diff", ".action-tile[data-open-view='terminal'] strong": "Chạy lệnh", ".action-tile[data-open-view='terminal'] small": "Terminal và tác vụ",
    ".approvals-card h3": "Chờ duyệt", ".approvals-card .empty-state": "Không có thao tác chờ duyệt.", ".dispatch-card h3": "Yêu cầu phối hợp", ".dispatch-card .empty-state": "Chưa có yêu cầu phối hợp task.",
    "#copy-task-overview": "Sao chép ID", "#view-files h1": "Tệp", "#view-files #save-file": "Lưu", "#view-changes h1": "Thay đổi", "#view-terminal h1": "Terminal", "#view-activity h1": "Hoạt động", "#view-connections h1": "Kết nối", "#view-settings h1": "Cài đặt"
  };
  for (const [selector, text] of Object.entries(texts)) { const node = document.querySelector(selector); if (node) node.textContent = text; }
  document.querySelector("#language-select").value = language;
  document.querySelector("#permission-mode option[value='ask']").textContent = languageText("ask");
  document.querySelector("#permission-mode option[value='auto']").textContent = languageText("auto");
  document.querySelector("#permission-mode option[value='full']").textContent = languageText("full");
  document.querySelector("#gh-state option[value='open']").textContent = language === "en" ? "Open" : "Đang mở";
  document.querySelector("#gh-state option[value='closed']").textContent = language === "en" ? "Closed" : "Đã đóng";
  document.querySelector("#gh-state option[value='all']").textContent = language === "en" ? "All" : "Tất cả";
  for (const [selector, vi, en] of [
    ["#rename-workspace", "Đổi tên workspace", "Rename workspace"],
    ["#remove-workspace", "Xóa workspace", "Remove workspace"],
    ["#rename-task", "Đổi tên task", "Rename task"],
    ["#delete-task", "Xóa task", "Delete task"]
  ]) {
    const button = document.querySelector(selector);
    button.setAttribute("aria-label", english ? en : vi);
    button.title = english ? en : vi;
  }
  renderApp(appState);
  renderWorkbench(workbench);
  localizeDom();
}
function setLanguage(next) { language = next === "en" ? "en" : "vi"; localStorage.setItem("coworker.language", language); applyLanguage(); }
function resolveTheme() { const saved = localStorage.getItem("coworker.theme") || "system"; return saved === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : saved; }
function applyTheme(origin) {
  const next = resolveTheme();
  const update = () => { document.documentElement.dataset.theme = next; };
  const x = origin?.clientX ?? innerWidth / 2;
  const y = origin?.clientY ?? innerHeight / 2;
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) { update(); return; }
  const transition = document.startViewTransition(update);
  transition.ready.then(() => {
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.documentElement.animate({ clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)", pseudoElement: "::view-transition-new(root)" });
  }).catch(() => {});
}

function setMessage(element, text, isError = false) {
  localizeStatusText(element, text, isError);
}

function renderApp(next) {
  appState = next;
  document.body.classList.toggle("mcp-off", !appState.mcpRunning);
  const mcpViews = new Set(["files", "changes", "terminal", "activity"]);
  document.querySelectorAll(".nav-item[data-view]").forEach(item => {
    const requiresMcp = mcpViews.has(item.dataset.view);
    item.disabled = requiresMcp && !appState.mcpRunning;
    item.classList.toggle("mcp-required", requiresMcp);
    item.title = item.disabled ? (language === "en" ? "Start MCP to open this section" : "Bật MCP để mở mục này") : "";
  });
  if (!appState.mcpRunning && mcpViews.has(document.querySelector(".nav-item.active")?.dataset.view)) activateView("overview");
  updateMcpControlAvailability();
  status.textContent = appState.mcpRunning ? "MCP đang chạy" : "MCP đã tắt";
  status.classList.toggle("running", appState.mcpRunning);
  document.querySelector("#status-dot").classList.toggle("running", appState.mcpRunning);
  endpoint.value = appState.endpoint || "—";
  token.value = appState.accessToken || "—";
  toggle.disabled = !appState.workspacePath && !appState.mcpRunning;
  toggle.textContent = appState.mcpRunning ? languageText("stop") : languageText("start");
  document.querySelector("#copy").disabled = !appState.mcpRunning;
  document.querySelector("#toolbar-workspace").textContent = appState.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || languageText("workspace");
  if (appState.tunnel) renderTunnelState(appState.tunnel);
  setMessage(connectionMessage, appState.startupMcpError || (appState.mcpRunning ? "Đang chạy" : "Đã tắt"), Boolean(appState.startupMcpError));
  document.querySelector("#mcp-offline-notice").hidden = appState.mcpRunning;
  queueMicrotask(localizeDom);
}

function updateMcpControlAvailability() {
  const enabled = Boolean(appState.mcpRunning);
  const blockedIds = [
    "permission-mode", "toggle-chat", "copy",
    "autologin-chat-profiles", "rename-chat-profile", "add-chat-profile", "forget-chat-profile",
    "copy-task-overview", "browse-path", "browser-path", "save-file", "refresh-changes", "refresh-jobs",
    "run-command", "start-job", "shell-command", "refresh-history", "create-handoff", "copy-handoff",
    "load-memory", "save-memory", "memory-content", "load-checkpoints", "checkpoint-select",
    "preview-checkpoint", "restore-checkpoint", "clear-checkpoints", "gh-auth", "gh-prs", "gh-issues",
    "gh-checks", "gh-create-pr", "gh-merge", "gh-state", "gh-search", "gh-number", "gh-title", "gh-body",
    "gh-merge-method", "gh-delete-branch", "action-tile-files", "action-tile-changes", "action-tile-terminal"
  ];
  for (const id of blockedIds) {
    const node = document.querySelector(`#${id}`);
    if (node) { node.disabled = !enabled; node.classList.toggle("mcp-required", !enabled); }
  }
  document.querySelectorAll(".action-tile[data-open-view]").forEach(node => {
    node.disabled = !enabled;
    node.classList.toggle("mcp-required", !enabled);
  });
  document.querySelectorAll(".nav-item[data-view]").forEach(node => {
    const blocked = ["overview", "files", "changes", "terminal", "activity"].includes(node.dataset.view);
    node.disabled = blocked && !enabled;
    node.classList.toggle("mcp-required", blocked && !enabled);
  });
}

function renderTunnelState(states) {
  const list = Array.isArray(states) ? states : [states];
  const labels = { disabled: "Đã tắt", stopped: "Đã dừng", starting: "Đang khởi động", running: "Đang chạy", error: "Lỗi" };
  const running = list.filter(state => state.status === "running").length;
  tunnelStatus.textContent = list.length ? `${running}/${list.length} đang chạy` : "Đã tắt";
  tunnelStatus.classList.toggle("running", running > 0);
  const container = document.querySelector("#tunnel-list");
  container.replaceChildren();
  for (const state of list) {
    const row = document.createElement("div");
    row.className = "tunnel-row";
    const info = document.createElement("div");
    info.className = "tunnel-row-info";
    const name = document.createElement("strong");
    name.textContent = state.label || state.tunnelId || "tunnel";
    const chip = document.createElement("span");
    chip.className = `status ${state.status === "running" ? "running" : ""}`;
    chip.textContent = labels[state.status] || state.status || "Đã tắt";
    const idText = document.createElement("span");
    idText.className = "tunnel-row-id";
    idText.textContent = state.tunnelId || "";
    info.append(name, chip, idText);
    const removeBtn = document.createElement("button");
    removeBtn.className = "button secondary";
    removeBtn.textContent = "Xóa";
    removeBtn.addEventListener("click", async () => {
      try {
        renderTunnelState(await window.coworker.removeTunnel(state.tunnelId));
        await loadTunnelConfig();
      } catch (error) { setMessage(tunnelMessage, error.message, true); }
    });
    row.append(info, removeBtn);
    container.append(row);
  }
  const errored = list.find(state => state.status === "error");
  const brief = errored ? errored.message || "Lỗi kết nối" : (list.length ? `${list.length} tunnel đã cấu hình.` : "");
  setMessage(tunnelMessage, brief);
  tunnelLogs.textContent = list.flatMap(state => (state.logs || []).slice(-10)).slice(-20).map(item => `[${new Date(item.at).toLocaleTimeString()}] ${item.text}`).join("\n") || brief || "—";
}

function appendOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}
function displayTaskTitle(title) {
  const value = String(title || "");
  const generated = value.match(/^(?:Tác vụ|Task) (\d+)$/);
  if (!generated) return value;
  return `${language === "en" ? "Task" : "Tác vụ"} ${generated[1]}`;
}

function renderApprovals(items = []) {
  approvals.replaceChildren();
  approvalCount.textContent = String(items.length);
  renderApprovalDock(items);
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Chưa có thao tác cần duyệt.";
    approvals.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "approval-item";
    const summary = document.createElement("p");
    summary.className = "approval-summary";
    summary.textContent = item.summary;
    const meta = document.createElement("div");
    meta.className = "approval-meta";
    meta.textContent = `${displayTaskTitle(item.taskTitle)} · ${item.risk} · ${new Date(item.createdAt).toLocaleTimeString()}`;
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    for (const [label, allow] of [["Từ chối", false], ["Cho phép lần này", true]]) {
      const button = document.createElement("button");
      button.className = `button ${allow ? "approve" : "deny"}`;
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await window.coworker.decideApproval(item.id, allow); }
        catch (error) { setMessage(connectionMessage, error.message, true); }
      });
      actions.append(button);
    }
    card.append(summary, meta, actions);
    approvals.append(card);
  }
}

function renderApprovalDock(items = []) {
  const dock = document.querySelector("#approval-dock");
  const item = items[0];
  dock.replaceChildren();
  dock.hidden = !item;
  updateChatLayout();
  if (!item) return;
  const summary = document.createElement("strong");
  summary.textContent = `${language === "en" ? "Approval needed" : "Cần bạn duyệt"}: ${item.summary}`;
  const detail = document.createElement("small");
  detail.textContent = `${item.risk} · ${displayTaskTitle(item.taskTitle)}`;
  const deny = document.createElement("button");
  deny.className = "button deny";
  deny.textContent = "Từ chối";
  const allow = document.createElement("button");
  allow.className = "button approve";
  allow.textContent = "Cho phép";
  for (const button of [deny, allow]) button.addEventListener("click", async () => {
    button.disabled = true;
    try { await window.coworker.decideApproval(item.id, button === allow); }
    catch (error) { setMessage(connectionMessage, error.message, true); }
  });
  dock.append(summary, detail, deny, allow);
}

function updateChatLayout() {
  const sidebarWidth = Math.round(document.querySelector(".sidebar").getBoundingClientRect().width);
  const dock = document.querySelector("#approval-dock");
  const dockHeight = dock.hidden ? 0 : Math.round(dock.getBoundingClientRect().height);
  void window.coworker.layoutChat({ sidebarWidth, dockHeight });
}

function renderWorkbench(next) {
  workbench = next || workbench;
  const previousWorkspace = workspaceSelect.value;
  workspaceSelect.replaceChildren();
  for (const item of workbench.workspaces || []) appendOption(workspaceSelect, item.id, item.name);
  workspaceSelect.value = workbench.workspaces?.some(item => item.id === workbench.defaultWorkspaceId) ? workbench.defaultWorkspaceId : previousWorkspace;
  workspaceSelect.disabled = !(workbench.workspaces?.length);

  const currentWorkspace = workspaceSelect.value || workbench.defaultWorkspaceId;
  const tasks = (workbench.tasks || []).filter(item => item.workspaceId === currentWorkspace && item.status === "active");
  taskSelect.replaceChildren();
  for (const item of tasks) appendOption(taskSelect, item.id, displayTaskTitle(item.title));
  taskSelect.value = tasks.some(item => item.id === workbench.defaultTaskId) ? workbench.defaultTaskId : tasks[0]?.id || "";
  taskSelect.disabled = !tasks.length;
  taskCount.textContent = language === "en" ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : `${tasks.length} tác vụ`;
  const selectedTask = tasks.find(item => item.id === taskSelect.value);
  taskId.textContent = selectedTask?.id || "—";
  document.querySelector("#toolbar-task").textContent = selectedTask ? displayTaskTitle(selectedTask.title) : "Task mới";
  document.querySelector("#overview-task-name").textContent = selectedTask ? displayTaskTitle(selectedTask.title) : (language === "en" ? "No task selected" : "Chưa chọn tác vụ");
  document.querySelector("#welcome-title").textContent = selectedTask ? displayTaskTitle(selectedTask.title) : (appState.workspacePath ? languageText("chooseOrCreate") : languageText("chooseWorkspace"));
  document.querySelector("#copy-task").disabled = !selectedTask;
  document.querySelector("#rename-workspace").disabled = !currentWorkspace;
  document.querySelector("#remove-workspace").disabled = !currentWorkspace;
  document.querySelector("#rename-task").disabled = !selectedTask;
  document.querySelector("#delete-task").disabled = !selectedTask;
  document.querySelector("#copy-task-overview").disabled = !selectedTask;
  document.querySelector("#create-task").disabled = !currentWorkspace;
  permissionSelect.disabled = !selectedTask || !appState.mcpRunning;
  permissionSelect.value = selectedTask?.permissionMode || "ask";
  renderApprovals(workbench.pendingApprovals || []);
  renderDispatch(workbench.dispatchMessages || [], workbench.defaultTaskId);
  const toolsReady = Boolean(selectedTask && appState.mcpRunning);
  for (const tile of document.querySelectorAll(".action-tile[data-open-view]")) {
    tile.disabled = !toolsReady;
    tile.title = toolsReady ? "" : (language === "en" ? "Start MCP and select a task first" : "Bật MCP và chọn tác vụ trước");
  }
  const taskChanged = Boolean(selectedTask && selectedTask.id !== renderedHistoryTask);
  if (taskChanged) {
    renderedHistoryTask = selectedTask.id;
    document.querySelector("#browser-path").value = ".";
    document.querySelector("#opened-file").textContent = "Chưa mở file";
    document.querySelector("#file-content").value = "";
    document.querySelector("#file-content").disabled = true;
    document.querySelector("#save-file").disabled = true;
  }
  if (!toolsReady) {
    renderedToolsTask = "";
    const offline = language === "en" ? "Start MCP to use workspace tools." : "Bật MCP để dùng công cụ workspace.";
    document.querySelector("#file-browser").textContent = offline;
    document.querySelector("#opened-file").textContent = language === "en" ? "No file open" : "Chưa mở file";
    document.querySelector("#file-content").value = "";
    document.querySelector("#file-content").disabled = true;
    document.querySelector("#save-file").disabled = true;
    document.querySelector("#git-status").textContent = offline;
    document.querySelector("#git-diff").textContent = "—";
    document.querySelector("#change-review").textContent = "";
    document.querySelector("#github-output").textContent = "—";
    document.querySelector("#jobs-list").textContent = offline;
    document.querySelector("#terminal-output").textContent = offline;
    document.querySelector("#memory-content").value = "";
    document.querySelector("#memory-content").disabled = true;
    document.querySelector("#checkpoint-select").replaceChildren();
    document.querySelector("#checkpoint-select").disabled = true;
    for (const id of ["preview-checkpoint", "restore-checkpoint", "clear-checkpoints"]) document.querySelector(`#${id}`).disabled = true;
  } else if (taskChanged || renderedToolsTask !== selectedTask.id) {
    renderedToolsTask = selectedTask.id;
    void refreshExplorer();
    void refreshGit();
    void refreshJobs();
    void loadMemory();
    void refreshCheckpoints();
  }
  if (selectedTask) void refreshHistory();
  document.querySelector("#refresh-history").disabled = !toolsReady;
  document.querySelector("#create-handoff").disabled = !toolsReady;
  document.querySelector("#copy-handoff").disabled = !toolsReady;
  for (const id of ["browse-path", "refresh-changes", "refresh-jobs", "run-command", "start-job"]) document.querySelector(`#${id}`).disabled = !toolsReady;
  for (const id of ["gh-auth", "gh-prs", "gh-issues", "gh-checks", "gh-create-pr", "gh-merge"]) document.querySelector(`#${id}`).disabled = !toolsReady;
  for (const id of ["load-memory", "save-memory", "load-checkpoints"]) document.querySelector(`#${id}`).disabled = !toolsReady;
  for (const id of ["browser-path", "shell-command", "gh-state", "gh-search", "gh-number", "gh-title", "gh-body", "gh-merge-method", "gh-delete-branch"]) document.querySelector(`#${id}`).disabled = !toolsReady;
  for (const id of ["permission-mode", "browse-path", "save-file", "refresh-changes", "refresh-jobs", "run-command", "start-job", "refresh-history", "create-handoff", "copy-handoff", "load-memory", "save-memory", "load-checkpoints", "preview-checkpoint", "restore-checkpoint", "clear-checkpoints", "gh-auth", "gh-prs", "gh-issues", "gh-checks", "gh-create-pr", "gh-merge"]) document.querySelector(`#${id}`)?.classList.toggle("mcp-required", !appState.mcpRunning);
  updateRefreshAvailability();
  updateMcpControlAvailability();
  queueMicrotask(localizeDom);
}

function updateRefreshAvailability() {
  const active = document.querySelector(".nav-item[data-view].active")?.dataset.view;
  document.querySelector("#refresh-current").disabled = ["files", "changes", "terminal", "activity"].includes(active) && !appState.mcpRunning;
}
function activateView(name) {
  document.querySelectorAll(".view-panel").forEach(panel => panel.classList.toggle("active", panel.id === `view-${name}`));
  document.querySelectorAll(".nav-item[data-view]").forEach(item => item.classList.toggle("active", item.dataset.view === name));
  updateRefreshAvailability();
}

function renderDispatch(messages, currentTaskId) {
  const container = document.querySelector("#dispatch-inbox");
  const queued = messages.filter(message => message.toTaskId === currentTaskId && message.status === "queued");
  document.querySelector("#dispatch-count").textContent = language === "en" ? `${queued.length} queued` : `${queued.length} đang chờ`;
  container.replaceChildren();
  if (!messages.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Chưa có yêu cầu phối hợp task."; container.append(empty); return; }
  for (const message of messages.slice(0, 10)) {
    const card = document.createElement("article"); card.className = "approval-item";
    const summary = document.createElement("p"); summary.className = "approval-summary"; summary.textContent = `${message.status} · ${message.fromTaskId} → ${message.toTaskId}`;
    const prompt = document.createElement("p"); prompt.className = "history-summary"; prompt.textContent = message.prompt;
    const actions = document.createElement("div"); actions.className = "approval-actions";
    const copy = document.createElement("button"); copy.className = "icon-button"; copy.textContent = "Copy prompt"; copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(`Bind this chat with workbench_bind_task(task_id="${currentTaskId}"). Then call task_dispatch(action="claim", message_id="${message.id}") and perform the request:\n\n${message.prompt}`); } catch (error) { setMessage(connectionMessage, error.message, true); } });
    actions.append(copy); card.append(summary, prompt, actions); container.append(card);
  }
}

async function callTool(toolName, args = {}) {
  if (!appState.mcpRunning) throw new Error(language === "en" ? "Start MCP before using workspace tools." : "Bật MCP trước khi dùng công cụ workspace.");
  const task = taskSelect.value;
  if (!task) throw new Error("Select an active task first.");
  const response = await window.coworker.callWorkbenchTool(task, toolName, args);
  const text = (response.content || []).filter(block => block.type === "text").map(block => block.text).join("\n");
  if (response.isError) throw new Error(text || `${toolName} failed.`);
  return text;
}

async function refreshExplorer() {
  const container = document.querySelector("#file-browser");
  try {
    const relative = document.querySelector("#browser-path").value.trim() || ".";
    const output = await callTool("workspace_list_files", { path: relative });
    if (!appState.mcpRunning) return;
    container.replaceChildren();
    if (relative !== ".") {
      const up = document.createElement("button"); up.className = "file-entry directory"; up.textContent = "↑ parent";
      up.addEventListener("click", () => { const parts = relative.replaceAll("\\", "/").split("/"); parts.pop(); document.querySelector("#browser-path").value = parts.join("/") || "."; void refreshExplorer(); });
      container.append(up);
    }
    const rows = output.split(/\r?\n/).filter(line => /^\[(?:dir|file)\] /.test(line));
    if (!rows.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = output || "(empty directory)"; container.append(empty); return; }
    for (const row of rows) {
      const isDir = row.startsWith("[dir] "); const name = row.slice(isDir ? 6 : 7);
      const button = document.createElement("button"); button.className = `file-entry ${isDir ? "directory" : ""}`; button.textContent = `${isDir ? "DIR  " : "FILE "}${name}`; button.title = name;
      button.dataset.path = [relative === "." ? "" : relative.replace(/[\\/]+$/, ""), name].filter(Boolean).join("/");
      if (!isDir && button.dataset.path === document.querySelector("#opened-file").textContent) button.setAttribute("aria-selected", "true");
      button.addEventListener("click", async () => {
        const base = relative === "." ? "" : relative.replace(/[\\/]+$/, "");
        const target = [base, name].filter(Boolean).join("/");
        if (isDir) { document.querySelector("#browser-path").value = target; await refreshExplorer(); }
        else await openFile(target);
      });
      container.append(button);
    }
  } catch (error) { if (!appState.mcpRunning) return; container.replaceChildren(); const message = document.createElement("p"); message.className = "empty-state"; message.textContent = error.message; container.append(message); }
}

async function openFile(relativePath) {
  try {
    const content = await callTool("workspace_read_file", { path: relativePath });
    if (!appState.mcpRunning) return;
    document.querySelector("#opened-file").textContent = relativePath;
    document.querySelectorAll("#file-browser .file-entry").forEach(entry => entry.setAttribute("aria-selected", String(entry.dataset.path === relativePath)));
    const editor = document.querySelector("#file-content"); editor.value = content; editor.disabled = false;
    document.querySelector("#save-file").disabled = false;
  } catch (error) { setMessage(connectionMessage, error.message, true); }
}

async function refreshGit() {
  try {
    const statusText = await callTool("git_status");
    const diffText = await callTool("git_diff");
    const reviewText = await callTool("workspace_review_changes");
    if (!appState.mcpRunning) return;
    document.querySelector("#git-status").textContent = statusText;
    document.querySelector("#git-diff").textContent = diffText;
    document.querySelector("#change-review").textContent = reviewText;
  } catch (error) {
    if (!appState.mcpRunning) return;
    document.querySelector("#git-status").textContent = error.message;
    document.querySelector("#git-diff").textContent = "";
    document.querySelector("#change-review").textContent = "";
  }
}

async function refreshJobs() {
  const container = document.querySelector("#jobs-list");
  try {
    const records = JSON.parse(await callTool("process_status"));
    if (!appState.mcpRunning) return;
    container.replaceChildren();
    for (const job of records) {
      const row = document.createElement("div"); row.className = "history-item";
      const title = document.createElement("span"); title.className = "history-tool"; title.textContent = `${job.status} · ${job.id}`;
      const command = document.createElement("span"); command.className = "history-summary"; command.textContent = job.command;
      const controls = document.createElement("span"); controls.className = "button-row";
      const output = document.createElement("button"); output.className = "icon-button"; output.textContent = "Log"; output.addEventListener("click", async () => { try { document.querySelector("#terminal-output").textContent = await callTool("process_output", { id: job.id }); } catch (error) { document.querySelector("#terminal-output").textContent = error.message; } });
      controls.append(output);
      if (job.status === "running") { const stop = document.createElement("button"); stop.className = "icon-button"; stop.textContent = "Stop"; stop.addEventListener("click", async () => { try { document.querySelector("#terminal-output").textContent = await callTool("stop_process", { id: job.id }); } catch (error) { document.querySelector("#terminal-output").textContent = error.message; } }); controls.append(stop); }
      row.append(title, command, controls); container.append(row);
    }
    if (!records.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Chưa có background job."; container.append(empty); }
  } catch (error) { if (appState.mcpRunning) container.textContent = error.message; }
}

async function loadMemory() {
  try {
    const content = await callTool("project_memory_read");
    if (!appState.mcpRunning) return;
    document.querySelector("#memory-content").value = content === "No project memory saved yet." ? "" : content;
    document.querySelector("#memory-content").disabled = false;
    setMessage(document.querySelector("#memory-message"), "");
  } catch (error) { setMessage(document.querySelector("#memory-message"), error.message, true); }
}

async function refreshCheckpoints() {
  const select = document.querySelector("#checkpoint-select");
  try {
    const parsed = JSON.parse(await callTool("rewind", { action: "list", limit: 50 }));
    if (!appState.mcpRunning) return;
    select.replaceChildren();
    for (const item of parsed.checkpoints || []) appendOption(select, item.id, `${new Date(item.createdAt).toLocaleString()} · ${item.path}`);
    if (!select.options.length) appendOption(select, "", "Chưa có checkpoint");
    const enabled = Boolean(select.value);
    select.disabled = !enabled;
    for (const id of ["preview-checkpoint", "restore-checkpoint", "clear-checkpoints"]) document.querySelector(`#${id}`).disabled = !enabled;
  } catch (error) { if (!appState.mcpRunning) return; select.replaceChildren(); appendOption(select, "", error.message); select.disabled = true; for (const id of ["preview-checkpoint", "restore-checkpoint", "clear-checkpoints"]) document.querySelector(`#${id}`).disabled = true; }
}

async function refreshHistory() {
  const selected = taskSelect.value;
  if (!selected || !appState.mcpRunning) {
    history.replaceChildren();
    const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Chọn task và bật MCP để xem lịch sử."; history.append(empty);
    return;
  }
  try {
    const events = await window.coworker.getTaskHistory(selected);
    const visible = events.filter(item => ["tool_finished", "tool_denied"].includes(item.type));
    history.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Task này chưa có thao tác."; history.append(empty); return;
    }
    for (const event of visible) {
      const row = document.createElement("div"); row.className = "history-item";
      const tool = document.createElement("span"); tool.className = "history-tool"; tool.textContent = event.tool || "operation";
      const summary = document.createElement("span"); summary.className = "history-summary"; summary.textContent = event.summary || "";
      const outcome = document.createElement("span"); outcome.className = `history-status ${event.status === "error" || event.type === "tool_denied" ? "error" : ""}`; outcome.textContent = event.type === "tool_denied" ? "denied" : `${event.status || "ok"} · ${event.durationMs ?? 0} ms`;
      row.append(tool, summary, outcome); history.append(row);
    }
  } catch (error) { history.textContent = error.message; }
}

async function loadUpstreamConfig() {
  try { upstreamConfig.value = JSON.stringify(await window.coworker.getUpstreamConfig(), null, 2); }
  catch (error) { setMessage(upstreamMessage, error.message, true); }
}

async function loadTunnelConfig() {
  try {
    tunnelConfigs = await window.coworker.getTunnelConfig();
    renderTunnelState(tunnelConfigs.map(config => ({ ...config, status: config.enabled ? "stopped" : "disabled" })));
  } catch (error) { setMessage(tunnelMessage, error.message, true); }
}

async function refreshUpstreamStatus() {
  try {
    const states = await window.coworker.getUpstreamStatus();
    upstreamStatus.textContent = states.length ? JSON.stringify(states, null, 2) : "Chưa cấu hình upstream nào.";
  } catch (error) { upstreamStatus.textContent = error.message; }
}

document.querySelector("#choose").addEventListener("click", async () => {
  try {
    await window.coworker.chooseWorkspace();
    appState = await window.coworker.getState();
    renderApp(appState);
    renderWorkbench(await window.coworker.getWorkbenchState());
  } catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelectorAll(".nav-item[data-view]").forEach(button => button.addEventListener("click", async () => { await window.coworker.closeChat(); activateView(button.dataset.view); }));
document.querySelectorAll("[data-open-view]").forEach(button => button.addEventListener("click", async () => { await window.coworker.closeChat(); activateView(button.dataset.openView); }));
document.querySelector(".sidebar-collapse").addEventListener("click", () => {
  const collapsed = document.querySelector(".app-shell").classList.toggle("sidebar-collapsed");
  localStorage.setItem("coworker.sidebarCollapsed", String(collapsed));
  document.querySelector(".sidebar-collapse").setAttribute("aria-label", collapsed ? "Mở thanh bên" : "Thu gọn thanh bên");
  updateChatLayout();
});
if (localStorage.getItem("coworker.sidebarCollapsed") === "true") document.querySelector(".app-shell").classList.add("sidebar-collapsed");
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); document.querySelector("#create-task").click(); }
});

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try {
    if (appState.mcpRunning) await window.coworker.stopMcp();
    else await window.coworker.startMcp();
  } catch (error) { setMessage(connectionMessage, error.message, true); }
  finally {
    appState = await window.coworker.getState().catch(() => appState);
    renderApp(appState);
    renderWorkbench(appState.workbench);
    toggle.disabled = !appState.workspacePath && !appState.mcpRunning;
  }
});

workspaceSelect.addEventListener("change", async () => {
  try { renderWorkbench(await window.coworker.selectWorkspace(workspaceSelect.value)); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

async function entityDialog(mode, label) {
  return window.coworker.showProfileDialog({ mode, label, language, theme: resolveTheme() });
}

document.querySelector("#rename-workspace").addEventListener("click", async () => {
  const item = workbench.workspaces.find(entry => entry.id === workspaceSelect.value);
  if (!item) return;
  const result = await entityDialog("rename-workspace", item.name);
  if (result?.action !== "save" || !String(result.value || "").trim()) return;
  try { await window.coworker.renameWorkspace(item.id, result.value); renderWorkbench(await window.coworker.getWorkbenchState()); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelector("#remove-workspace").addEventListener("click", async () => {
  const item = workbench.workspaces.find(entry => entry.id === workspaceSelect.value);
  if (!item || (await entityDialog("remove-workspace", item.name))?.action !== "remove") return;
  try { renderWorkbench(await window.coworker.removeWorkspace(item.id)); appState = await window.coworker.getState(); renderApp(appState); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

taskSelect.addEventListener("change", async () => {
  try { await window.coworker.selectTask(taskSelect.value); renderedHistoryTask = ""; renderWorkbench(await window.coworker.getWorkbenchState()); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelector("#create-task").addEventListener("click", async () => {
  try {
    const title = `${language === "en" ? "Task" : "Tác vụ"} ${(workbench.tasks || []).filter(item => item.workspaceId === workspaceSelect.value).length + 1}`;
    const task = await window.coworker.createTask(workspaceSelect.value, title);
    renderedHistoryTask = ""; renderWorkbench(await window.coworker.getWorkbenchState()); taskSelect.value = task.id; renderWorkbench(workbench);
  } catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelector("#rename-task").addEventListener("click", async () => {
  const item = workbench.tasks.find(entry => entry.id === taskSelect.value);
  if (!item) return;
  const result = await entityDialog("rename-task", item.title);
  if (result?.action !== "save" || !String(result.value || "").trim()) return;
  try { await window.coworker.renameTask(item.id, result.value); renderWorkbench(await window.coworker.getWorkbenchState()); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

permissionSelect.addEventListener("change", async () => {
  try { await window.coworker.setTaskPermission(taskSelect.value, permissionSelect.value); renderWorkbench(await window.coworker.getWorkbenchState()); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelector("#copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(`${appState.endpoint}\nAuthorization: Bearer ${appState.accessToken}`); setMessage(connectionMessage, "Đã sao chép."); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelector("#copy-task").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(taskSelect.value); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});
document.querySelector("#copy-task-overview").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(taskSelect.value); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});
document.querySelector("#delete-task").addEventListener("click", async () => {
  const item = workbench.tasks.find(entry => entry.id === taskSelect.value);
  if (!item || (await entityDialog("delete-task", item.title))?.action !== "remove") return;
  try { await window.coworker.deleteTask(taskSelect.value); renderedHistoryTask = ""; renderWorkbench(await window.coworker.getWorkbenchState()); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelector("#refresh-history").addEventListener("click", refreshHistory);
let latestHandoff = null;
document.querySelector("#create-handoff").addEventListener("click", async () => {
  try { latestHandoff = await window.coworker.createHandoff(taskSelect.value, profileState.activeProfileId); setMessage(connectionMessage, language === "en" ? "Handoff created." : "Đã tạo handoff."); document.querySelector("#copy-handoff").disabled = false; }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});
document.querySelector("#copy-handoff").addEventListener("click", async () => {
  try { if (!latestHandoff) latestHandoff = await window.coworker.latestHandoff(taskSelect.value); if (!latestHandoff) throw new Error(language === "en" ? "Create a handoff first." : "Hãy tạo handoff trước."); const resume = latestHandoff.markdown || `Use Coworker. Call workbench_status and workbench_bind_task with task_id="${latestHandoff.task.id}" before editing.`; await navigator.clipboard.writeText(resume); setMessage(connectionMessage, language === "en" ? "Resume handoff copied." : "Đã sao chép handoff tiếp tục."); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});
document.querySelector("#refresh-current").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.classList.add("refreshing");
  button.disabled = true;
  const view = document.querySelector(".nav-item[data-view].active")?.dataset.view || "overview";
  try {
    if (view === "files") await refreshExplorer();
    else if (view === "changes") await refreshGit();
    else if (view === "terminal") await refreshJobs();
    else if (view === "activity") await Promise.all([refreshHistory(), refreshCheckpoints()]);
    else renderWorkbench(await window.coworker.getWorkbenchState());
    await new Promise(resolve => setTimeout(resolve, 450));
  } catch (error) { setMessage(connectionMessage, error.message, true); }
  finally { button.classList.remove("refreshing"); updateRefreshAvailability(); }
});

document.querySelector("#load-memory").addEventListener("click", loadMemory);
document.querySelector("#save-memory").addEventListener("click", async () => {
  try { await callTool("project_memory_replace", { content: document.querySelector("#memory-content").value }); setMessage(document.querySelector("#memory-message"), "Đã lưu."); }
  catch (error) { setMessage(document.querySelector("#memory-message"), error.message, true); }
});
document.querySelector("#load-checkpoints").addEventListener("click", refreshCheckpoints);
document.querySelector("#preview-checkpoint").addEventListener("click", async () => {
  try { document.querySelector("#checkpoint-preview").textContent = await callTool("rewind", { action: "preview", checkpoint_id: document.querySelector("#checkpoint-select").value }); }
  catch (error) { document.querySelector("#checkpoint-preview").textContent = error.message; }
});
document.querySelector("#restore-checkpoint").addEventListener("click", async () => {
  try { document.querySelector("#checkpoint-preview").textContent = await callTool("rewind", { action: "restore", checkpoint_id: document.querySelector("#checkpoint-select").value }); await refreshExplorer(); await refreshGit(); await refreshCheckpoints(); }
  catch (error) { document.querySelector("#checkpoint-preview").textContent = error.message; }
});
document.querySelector("#clear-checkpoints").addEventListener("click", async () => {
  try { document.querySelector("#checkpoint-preview").textContent = await callTool("rewind", { action: "clear" }); await refreshCheckpoints(); }
  catch (error) { document.querySelector("#checkpoint-preview").textContent = error.message; }
});

const tourSteps = [
  { target: "#choose", title: "Chọn workspace", body: "Bấm <b>Thêm workspace</b>, chọn thư mục dự án bạn muốn làm việc và xác nhận. Coworker sẽ dùng thư mục này cho file, lệnh và Git." },
  { target: "#toggle", title: "Bật MCP", body: "Bấm <b>Bật</b> ở cuối thanh bên. Khi thành công, trạng thái đổi thành <b>MCP đang chạy</b> và nút đổi thành <b>Tắt</b>." },
  { target: "#create-task", title: "Tạo task", body: "Bấm <b>Task mới</b> cho công việc đầu tiên. Giữ chế độ <b>Hỏi trước</b> để duyệt thao tác sửa file hoặc chạy lệnh." },
  { target: ".nav-item[data-view='connections']", title: "Mở Kết nối", body: "Bấm <b>Kết nối</b> ở thanh bên. Mục Secure MCP Tunnel là nơi nhập các thông tin tạo ở những bước tiếp theo." },
  { target: "#tunnel-label", view: "connections", title: "Thêm tunnel cho từng tài khoản", body: "<b>Tùy chọn cho nhiều tài khoản:</b> mỗi tài khoản ChatGPT cần một tunnel riêng. Các bước tiếp theo sẽ hướng dẫn tạo Tunnel ID và Runtime API key cho tài khoản đầu tiên. Sau khi thêm tài khoản khác ở bước cuối, lặp lại các bước tạo tunnel và key bằng tài khoản đó; điền <b>Tên (tài khoản)</b> để dễ nhận biết rồi lưu. Mỗi tunnel dùng một Runtime API key riêng." },
  { target: "#tunnel-id", view: "connections", title: "Tạo Tunnel ID", body: "Mở <a href=\"https://platform.openai.com/settings/organization/tunnels\" target=\"_blank\" rel=\"noopener\">OpenAI Platform → Tunnels ↗</a>. Chọn Organization, bấm <b>Create tunnel</b>, nhập tên và mô tả, chọn đúng ChatGPT workspace rồi bấm <b>Create</b>. Sao chép Tunnel ID và dán vào ô đang được đánh dấu.", image: "step-2-tunnel.jpg" },
  { target: "#tunnel-api-key", view: "connections", title: "Tạo Runtime API key", body: "Mở <a href=\"https://platform.openai.com/settings/organization/api-keys\" target=\"_blank\" rel=\"noopener\">OpenAI Platform → Organization API Keys ↗</a>, chọn <b>Runtime API Keys</b> và tạo key. Đặt tên dễ nhớ; nếu có mục quyền, chọn <b>Restricted → Tunnels Read + Use</b>. Sao chép key ngay và dán vào ô đang được đánh dấu.", image: "step-3-api-key.jpg", imageCaption: "Ảnh minh họa form tạo key. Ở mục Permissions, dùng Restricted và cấp Tunnels Read + Use." },
  { target: "#tunnel-binary", view: "connections", title: "Tải tunnel-client", body: "Mở <a href=\"https://github.com/openai/tunnel-client/releases/latest\" target=\"_blank\" rel=\"noopener\">bản tunnel-client mới nhất ↗</a>. Trên Windows x64, tải file dạng <code>tunnel-client-vX.Y.Z-windows-amd64.zip</code>, giải nén vào thư mục cố định, rồi bấm <b>Duyệt</b> để chọn <code>tunnel-client.exe</code>." },
  { target: "#save-tunnel", view: "connections", title: "Lưu và chạy tunnel", body: "Bật <b>Bật tunnel</b>, kiểm tra ba ô Tunnel ID, Runtime API key và đường dẫn <code>tunnel-client.exe</code>, rồi bấm <b>Lưu</b>. Giữ Coworker mở; xem trạng thái và log ngay dưới nút Lưu." },
  { target: "#toggle-chat", title: "Bật Developer Mode", body: "Bấm <b>Ẩn tạm</b> để thao tác mà không mất bước, rồi bấm <b>ChatGPT</b> trên thanh trên cùng và đăng nhập. Trong ChatGPT, mở <b>Settings → Security and login</b>, cuộn đến <b>Developer mode</b> và bật công tắc như ảnh. Sau đó bấm dấu <b>?</b> của Coworker để tiếp tục hướng dẫn.", image: "step-5-developer-mode.jpg" },
  { target: "#toggle-chat", title: "Tạo app Coworker trong ChatGPT", body: "Trong ChatGPT, mở <b>Cài đặt → Plugin</b>, vào <b>trang quản lý plugin</b>, bấm dấu <b>+</b> rồi chọn <b>Ứng dụng mới</b>. Đặt tên <b>Coworker</b>, chọn <b>Connection = Tunnel</b>, chọn tunnel vừa tạo, <b>Authentication = No Auth</b>, tích xác nhận rồi bấm <b>Tạo</b>. Chờ ChatGPT quét công cụ xong.", image: "step-6-plugin.jpg" },
  { target: "#toggle-chat", title: "Kiểm tra và bắt đầu", body: "Trong chat mới, chọn app <b>Coworker</b> rồi gửi: <code>Dùng Coworker gọi workbench_status, liệt kê workspace và task, sau đó bind vào task đã chọn.</code> Nếu ChatGPT gọi được công cụ, kết nối đã hoàn tất. Khi có yêu cầu duyệt, dùng thanh ở dưới cùng Coworker." },
  { target: "#autologin-chat-profiles", title: "Thêm nhiều tài khoản ChatGPT", body: "Bấm nút <b>mũi tên vòng tròn</b> cạnh ô profile để mở <b>Đăng nhập tự động</b>. Dán tài khoản theo dạng <code>email | mật khẩu | mã 2FA</code> (mỗi dòng một tài khoản, 2FA bỏ trống nếu không có) rồi bấm <b>Thêm vào danh sách</b>. Tài khoản Google thì bấm <b>Đăng nhập bằng Google</b> và tự đăng nhập trong cửa sổ hiện ra. Chọn profile cho từng tài khoản ở dropdown — mỗi profile chỉ giữ một tài khoản." }
];
const tourOrderVersion = "3";
const legacyTourIndex = Number(localStorage.getItem("coworker.tour.progress"));
if (localStorage.getItem("coworker.tour.order-version") !== tourOrderVersion) {
  if (localStorage.getItem("coworker.tour.v2") !== "done" && Number.isInteger(legacyTourIndex) && legacyTourIndex >= 0 && legacyTourIndex < tourSteps.length) {
    localStorage.setItem("coworker.tour.progress", String(legacyTourIndex === 12 ? 4 : legacyTourIndex >= 4 ? legacyTourIndex + 1 : legacyTourIndex));
  }
  localStorage.setItem("coworker.tour.order-version", tourOrderVersion);
}
const savedTourIndex = Number(localStorage.getItem("coworker.tour.progress"));
let tourIndex = Number.isInteger(savedTourIndex) && savedTourIndex >= 0 && savedTourIndex < tourSteps.length ? savedTourIndex : 0;
const tourEnglish = [
  ["Choose a workspace", "Click <b>Add workspace</b>, choose the project folder you want to use, and confirm. Coworker uses this folder for files, commands, and Git."],
  ["Start MCP", "Click <b>Start</b> at the bottom of the sidebar. The status changes to <b>MCP is running</b> and the button changes to <b>Stop</b>."],
  ["Create a task", "Click <b>New task</b>. Keep <b>Ask first</b> enabled while you are getting started so file changes and commands wait for your approval."],
  ["Open Connections", "Open <b>Connections</b> in the sidebar. Secure MCP Tunnel is where you enter the values from the next steps."],
  ["Add a tunnel per account", "<b>Optional for multiple accounts:</b> each ChatGPT account needs its own tunnel. The next steps create a Tunnel ID and Runtime API key for your first account. After adding another account in the final step, repeat tunnel and key creation with that account; use the account <b>label</b> to identify it and save. Each tunnel needs a separate Runtime API key."],
  ["Create a Tunnel ID", "Open <a href=\"https://platform.openai.com/settings/organization/tunnels\" target=\"_blank\">OpenAI Platform → Tunnels ↗</a>. Choose your Organization, click <b>Create tunnel</b>, enter a name and description, select the correct ChatGPT workspace, then click <b>Create</b>. Copy the Tunnel ID into the highlighted field."],
  ["Create a Runtime API key", "Open <a href=\"https://platform.openai.com/settings/organization/api-keys\" target=\"_blank\">Organization API Keys ↗</a>, choose <b>Runtime API Keys</b>, and create a key. If permissions are available, choose <b>Restricted → Tunnels Read + Use</b>. Copy the key into the highlighted field."],
  ["Download tunnel-client", "Open the <a href=\"https://github.com/openai/tunnel-client/releases/latest\" target=\"_blank\">latest tunnel-client release ↗</a>. On Windows x64, download <code>tunnel-client-vX.Y.Z-windows-amd64.zip</code>, extract it to a stable folder, and choose <code>tunnel-client.exe</code>."],
  ["Save and run the tunnel", "Enable <b>Enable tunnel</b>, check the Tunnel ID, Runtime API key, and <code>tunnel-client.exe</code> path, then click <b>Save</b>. Keep Coworker open and watch the tunnel status and log."],
  ["Enable Developer Mode", "Click <b>Hide for now</b> so you can work without losing this step. Open <b>ChatGPT</b>, sign in, then go to <b>Settings → Security and login</b> and enable <b>Developer mode</b>. Click Coworker's <b>?</b> button to continue."],
  ["Create the Coworker app in ChatGPT", "In ChatGPT, open <b>Settings → Plugin</b>, go to the <b>plugin management page</b>, click <b>+</b>, then choose <b>New app</b>. Name it <b>Coworker</b>, choose <b>Connection = Tunnel</b>, select your tunnel, choose <b>Authentication = No Auth</b>, accept the warning, and click <b>Create</b>. Wait for tool scanning to finish."],
  ["Test the connection", "In a new chat, select the <b>Coworker</b> app and send: <code>Use Coworker to call workbench_status, list workspaces and tasks, then bind this chat to the selected task.</code> If ChatGPT calls the tool, setup is complete."],
  ["Add more ChatGPT accounts", "Click the <b>circular-arrows button</b> next to the profile box to open <b>Auto login</b>. Paste accounts as <code>email | password | 2FA code</code> (one per line; leave 2FA empty if unused), then click <b>Add to list</b>. For Google accounts, click <b>Sign in with Google</b> and finish signing in yourself in the window that appears. Assign each account a profile in its dropdown — one profile holds one account."]
];
const tourEnglishCaptions = { 6: "Illustration of the key form. Choose Restricted and grant Tunnels Read + Use." };
const optionalTourTitles = {
  vi: { 4: "Tùy chọn: Thêm tunnel cho từng tài khoản", 12: "Tùy chọn: Thêm nhiều tài khoản ChatGPT" },
  en: { 4: "Optional: Add a tunnel per account", 12: "Optional: Add more ChatGPT accounts" }
};
let tourRevision = 0;
let tourRendering = false;
let tourLayoutFrame = 0;
// Highlight the actual browse action rather than the path value beside it.
tourSteps[7].target = "#choose-tunnel-binary";
function presentedTourStep() {
  const step = tourSteps[tourIndex];
  if (!step) return undefined;
  const [englishTitle, body] = tourEnglish[tourIndex] || [];
  const title = optionalTourTitles[language]?.[tourIndex] || (language === "en" ? englishTitle : step.title);
  if (language !== "en") return title === step.title ? step : { ...step, title };
  return { ...step, title, body, imageCaption: tourEnglishCaptions[tourIndex] || "" };
}
async function renderTour() {
  const step = presentedTourStep();
  if (!step) return finishTour();
  const revision = ++tourRevision;
  tourRendering = true;
  nativeTourVisible = true;
  document.body.classList.add("tour-active");
  document.querySelectorAll(".tour-target").forEach(item => item.classList.remove("tour-target"));
  try {
    const target = document.querySelector(step.target);
    if (!target) throw new Error(language === "en" ? "This guide control is unavailable." : "Không tìm thấy điều khiển của bước này.");
    if (target.closest(".sidebar")) {
      document.querySelector(".app-shell").classList.remove("sidebar-collapsed");
      updateChatLayout();
    }
    if (step.view) {
      activateView(step.view);
      document.querySelector(".tunnel-card").open = true;
    }
    if (chatVisible && step.view) {
      await window.coworker.closeChat();
      if (revision !== tourRevision) return;
      renderChatState(false);
    }
    target.scrollIntoView({ block: step.view ? "center" : "nearest", inline: "nearest", behavior: "instant" });
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (revision !== tourRevision) return;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error(language === "en" ? "Expand the window to see this control." : "Mở rộng cửa sổ để thấy điều khiển này.");
    target.classList.add("tour-target");
    localStorage.setItem("coworker.tour.progress", String(tourIndex));
    const prerequisite = target.disabled ? (language === "en" ? "<p>Complete the earlier steps to enable this control. Use Back to review them.</p>" : "<p>Hoàn tất các bước trước để bật điều khiển này. Bấm Quay lại để xem lại.</p>") : "";
    await window.coworker.showTourNative({
    title: step.title,
    body: step.body + prerequisite,
    image: step.image,
    imageCaption: step.imageCaption,
    language,
    theme: resolveTheme(),
    index: tourIndex,
    total: tourSteps.length,
    last: tourIndex === tourSteps.length - 1,
    target: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    });
  } catch (error) {
    if (revision !== tourRevision) return;
    hideTour();
    setMessage(connectionMessage, `Không mở được lớp hướng dẫn: ${error.message}`, true);
  } finally {
    if (revision === tourRevision) tourRendering = false;
  }
}
function scheduleTourLayout() {
  if (!nativeTourVisible || tourRendering || tourLayoutFrame) return;
  tourLayoutFrame = requestAnimationFrame(() => {
    tourLayoutFrame = 0;
    if (!nativeTourVisible || tourRendering) return;
    const target = document.querySelector(presentedTourStep()?.target);
    const rect = target?.getBoundingClientRect();
    if (!rect?.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return hideTour();
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < clip.left || rect.right > clip.right)) return hideTour();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < clip.top || rect.bottom > clip.bottom)) return hideTour();
    }
    void window.coworker.showTourNative({ layoutOnly: true, target: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }).catch(() => hideTour());
  });
}
function hideTour() {
  tourRevision += 1;
  tourRendering = false;
  document.body.classList.remove("tour-active");
  document.querySelectorAll(".tour-target").forEach(item => item.classList.remove("tour-target"));
  void window.coworker.hideTourNative(); nativeTourVisible = false;
  localStorage.setItem("coworker.tour.progress", String(tourIndex));
}
function finishTour() {
  hideTour();
  localStorage.removeItem("coworker.tour.progress");
  localStorage.setItem("coworker.tour.v2", "done");
}
document.querySelector("#show-tour").addEventListener("click", () => {
  if (!localStorage.getItem("coworker.tour.progress")) tourIndex = 0;
  renderTour();
});
window.addEventListener("resize", () => {
  updateChatLayout();
  scheduleTourLayout();
});
document.addEventListener("scroll", scheduleTourLayout, true);
new ResizeObserver(scheduleTourLayout).observe(document.querySelector(".app-shell"));
new MutationObserver(scheduleTourLayout).observe(document.querySelector(".app-shell"), { attributes: true, subtree: true, attributeFilter: ["class", "open", "hidden"] });
window.coworker.onTourAction(action => {
  if (action === "hide") hideTour();
  else if (action === "skip") finishTour();
  else if (action === "next") { tourIndex += 1; void renderTour(); }
  else if (action === "back" && tourIndex > 0) { tourIndex -= 1; void renderTour(); }
});
window.coworker.onNativeTourState(visible => { nativeTourVisible = Boolean(visible); });

const chatButton = document.querySelector("#toggle-chat");
function renderChatState(visible) {
  chatVisible = visible;
  chatButton.classList.toggle("active", visible);
  chatButton.querySelector("span").textContent = visible ? "Đóng ChatGPT" : "ChatGPT";
  chatButton.setAttribute("aria-pressed", String(visible));
}
chatButton.addEventListener("click", async () => {
  try {
    if (nativeTourVisible) {
      hideTour();
      await window.coworker.hideTourNative();
    }
    updateChatLayout(); renderChatState(await window.coworker.toggleChat());
  }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});
profileSelect.addEventListener("change", async () => {
  try { await window.coworker.switchProfile(profileSelect.value); }
  catch (error) { setMessage(connectionMessage, error.message, true); renderProfiles(profileState); }
});

function requestProfileName(initialValue = "") {
  // ChatGPT is a native WebContentsView above this renderer. Use the native
  // profile card so add/rename remains clickable instead of being hidden under it.
  return window.coworker.showProfileDialog({ mode: initialValue ? "rename" : "add", label: initialValue, language, theme: resolveTheme() }).then(result => result?.action === "save" ? String(result.value || "").trim() : "");
}

function confirmForgetProfile(label) {
  // Keep confirmation in the same native layer for the WebView-open case.
  return window.coworker.showProfileDialog({ mode: "forget", label, language, theme: resolveTheme() }).then(result => result?.action === "forget");
}

async function withChatTemporarilyHidden(action) { return action(); }

document.querySelector("#add-chat-profile").addEventListener("click", async () => {
  await withChatTemporarilyHidden(async () => {
    const label = await requestProfileName();
    if (!label) return;
    try { const profile = await window.coworker.createProfile(label); renderProfiles(await window.coworker.getProfiles()); await window.coworker.switchProfile(profile.id); }
    catch (error) { setMessage(connectionMessage, error.message, true); }
  });
});
document.querySelector("#rename-chat-profile").addEventListener("click", async () => {
  await withChatTemporarilyHidden(async () => {
    const current = profileState.profiles.find(item => item.id === profileState.activeProfileId);
    if (!current) return;
    const label = await requestProfileName(current.label);
    if (!label) return;
    try { await window.coworker.renameProfile(current.id, label); renderProfiles(await window.coworker.getProfiles()); }
    catch (error) { setMessage(connectionMessage, error.message, true); }
  });
});
document.querySelector("#forget-chat-profile").addEventListener("click", async () => {
  await withChatTemporarilyHidden(async () => {
    const current = profileState.profiles.find(item => item.id === profileState.activeProfileId);
    if (!current || !await confirmForgetProfile(current.label)) return;
    try { renderProfiles(await window.coworker.forgetProfile(current.id)); }
    catch (error) { setMessage(connectionMessage, error.message, true); }
  });
});

document.querySelector("#autologin-chat-profiles").addEventListener("click", async () => {
  try { await window.coworker.openAutoLogin(document.documentElement.dataset.theme, language); }
  catch (error) { setMessage(connectionMessage, error.message, true); }
});

document.querySelector("#browse-path").addEventListener("click", refreshExplorer);
document.querySelector("#browser-path").addEventListener("keydown", event => { if (event.key === "Enter") void refreshExplorer(); });
document.querySelector("#save-file").addEventListener("click", async () => {
  const relative = document.querySelector("#opened-file").textContent;
  if (!relative || relative === "Chưa mở file") return;
  try { await callTool("workspace_write_file", { path: relative, content: document.querySelector("#file-content").value }); setMessage(document.querySelector("#file-message"), "Đã lưu."); await refreshExplorer(); }
  catch (error) { setMessage(document.querySelector("#file-message"), error.message, true); }
});
document.querySelector("#refresh-changes").addEventListener("click", refreshGit);
document.querySelector("#refresh-jobs").addEventListener("click", refreshJobs);
document.querySelector("#run-command").addEventListener("click", async () => {
  try { document.querySelector("#terminal-output").textContent = await callTool("run_command", { command: document.querySelector("#shell-command").value, timeout_seconds: 60 }); await refreshJobs(); }
  catch (error) { document.querySelector("#terminal-output").textContent = error.message; }
});
document.querySelector("#start-job").addEventListener("click", async () => {
  try { document.querySelector("#terminal-output").textContent = await callTool("start_process", { command: document.querySelector("#shell-command").value }); await refreshJobs(); }
  catch (error) { document.querySelector("#terminal-output").textContent = error.message; }
});

document.querySelector("#gh-auth").addEventListener("click", async () => {
  try { document.querySelector("#github-output").textContent = await callTool("github_auth_status"); }
  catch (error) { document.querySelector("#github-output").textContent = error.message; }
});
document.querySelector("#gh-prs").addEventListener("click", async () => {
  try { document.querySelector("#github-output").textContent = await callTool("github_list_pull_requests", { state: document.querySelector("#gh-state").value, limit: 30 }); }
  catch (error) { document.querySelector("#github-output").textContent = error.message; }
});
document.querySelector("#gh-issues").addEventListener("click", async () => {
  try { document.querySelector("#github-output").textContent = await callTool("github_list_issues", { state: document.querySelector("#gh-state").value, limit: 30, search: document.querySelector("#gh-search").value }); }
  catch (error) { document.querySelector("#github-output").textContent = error.message; }
});
document.querySelector("#gh-checks").addEventListener("click", async () => {
  try { const number = Number(document.querySelector("#gh-number").value); document.querySelector("#github-output").textContent = await callTool("github_pull_request_checks", number > 0 ? { number } : {}); }
  catch (error) { document.querySelector("#github-output").textContent = error.message; }
});
document.querySelector("#gh-create-pr").addEventListener("click", async () => {
  try { document.querySelector("#github-output").textContent = await callTool("github_create_draft_pull_request", { title: document.querySelector("#gh-title").value, body: document.querySelector("#gh-body").value }); }
  catch (error) { document.querySelector("#github-output").textContent = error.message; }
});
document.querySelector("#gh-merge").addEventListener("click", async () => {
  try { const number = Number(document.querySelector("#gh-number").value); document.querySelector("#github-output").textContent = await callTool("github_merge_pull_request", { number, method: document.querySelector("#gh-merge-method").value, delete_branch: document.querySelector("#gh-delete-branch").checked }); }
  catch (error) { document.querySelector("#github-output").textContent = error.message; }
});

document.querySelector("#save-upstreams").addEventListener("click", async () => {
  try {
    const servers = JSON.parse(upstreamConfig.value || "[]");
    const states = await window.coworker.saveUpstreamConfig(servers);
    upstreamStatus.textContent = states.length ? JSON.stringify(states, null, 2) : "Đã lưu. Chưa có upstream nào.";
    setMessage(upstreamMessage, "Đã lưu cấu hình upstream.");
  } catch (error) { setMessage(upstreamMessage, error.message, true); }
});
document.querySelector("#refresh-upstreams").addEventListener("click", refreshUpstreamStatus);

document.querySelector("#choose-tunnel-binary").addEventListener("click", async () => {
  try {
    const selected = await window.coworker.chooseTunnelBinary();
    if (selected) document.querySelector("#tunnel-binary").value = selected;
  } catch (error) { setMessage(tunnelMessage, error.message, true); }
});

let tunnelConfigs = [];

document.querySelector("#save-tunnel").addEventListener("click", async () => {
  try {
    const label = document.querySelector("#tunnel-label").value.trim();
    const tunnelId = document.querySelector("#tunnel-id").value.trim();
    const binaryPath = document.querySelector("#tunnel-binary").value.trim();
    const runtimeApiKey = document.querySelector("#tunnel-api-key").value;
    // Add/replace one entry: a fresh key replaces the stored one; an empty
    // key reuses the stored value (edit by id without re-entering secrets).
    const existing = tunnelConfigs.find(config => config.tunnelId === tunnelId);
    const entry = {
      enabled: document.querySelector("#tunnel-enabled").checked,
      label,
      tunnelId,
      runtimeApiKey: runtimeApiKey || existing?.runtimeApiKey || "",
      binaryPath: binaryPath || existing?.binaryPath || ""
    };
    const next = await window.coworker.saveTunnelConfig([entry, ...tunnelConfigs.filter(config => config.tunnelId !== tunnelId)]);
    // The save response strips secrets; reload through getTunnelConfig so the
    // next save re-sends complete entries.
    await loadTunnelConfig();
    renderTunnelState(next);
    document.querySelector("#tunnel-id").value = "";
    document.querySelector("#tunnel-label").value = "";
    document.querySelector("#tunnel-api-key").value = "";
  } catch (error) { setMessage(tunnelMessage, error.message, true); }
});
document.querySelector("#language-select").addEventListener("change", event => setLanguage(event.target.value));
document.querySelector("#auto-start-mcp").addEventListener("change", async event => {
  const checkbox = event.currentTarget;
  checkbox.disabled = true;
  try { checkbox.checked = await window.coworker.setAutoStartMcp(checkbox.checked); setMessage(document.querySelector("#auto-start-mcp-message"), ""); }
  catch (error) { checkbox.checked = !checkbox.checked; setMessage(document.querySelector("#auto-start-mcp-message"), error.message, true); }
  finally { checkbox.disabled = false; }
});
document.querySelector("#theme-select").value = localStorage.getItem("coworker.theme") || "system";
document.querySelector("#theme-select").addEventListener("change", event => { localStorage.setItem("coworker.theme", event.target.value); applyTheme(event); });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if ((localStorage.getItem("coworker.theme") || "system") === "system") applyTheme(); });

window.coworker.onState(next => { renderApp(next); if (next.workbench) renderWorkbench(next.workbench); });
window.coworker.onWorkbenchState(renderWorkbench);
window.coworker.onApprovalRequired(approval => { void window.coworker.getWorkbenchState().then(renderWorkbench); void window.coworker.notifyApproval(approval?.summary, language); });
window.coworker.onTunnelState(renderTunnelState);
window.coworker.onChatState(renderChatState);
window.coworker.onProfilesState(renderProfiles);
appState = await window.coworker.getState();
renderApp(appState);
renderWorkbench(appState.workbench);
renderTunnelState(appState.tunnel);
await loadTunnelConfig();
await loadUpstreamConfig();
await refreshUpstreamStatus();
renderProfiles(await window.coworker.getProfiles());
try { document.querySelector("#auto-start-mcp").checked = (await window.coworker.getPreferences()).autoStartMcp; }
catch (error) { setMessage(document.querySelector("#auto-start-mcp-message"), error.message, true); }
applyTheme();
applyLanguage();
if (localStorage.getItem("coworker.tour.v2") !== "done") setTimeout(renderTour, 350);
