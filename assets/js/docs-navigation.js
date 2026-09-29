(() => {
  "use strict";
  const pages = [
    { id: "overview", title: "Coworker documentation", label: "Overview", description: "Coworker brings ChatGPT into your project workspace to read files, edit code and run commands. Choose an access mode and follow each action in the app.", sections: ["overview-concepts", "overview-path"] },
    { id: "install", title: "Installation", description: "Install Coworker on 64-bit Windows 10/11, then set up your workspace.", sections: ["install"] },
    { id: "quickstart", title: "Quickstart", description: "From installation to your first tool call: create a tunnel, connect ChatGPT and verify Coworker.", sections: ["quickstart", "workspaces"] },
    { id: "profiles", title: "Multiple accounts", description: "Assign ChatGPT accounts to independent profiles and switch between them safely.", sections: ["profiles"] },
    { id: "tunnels", title: "Multiple tunnels", description: "Give each ChatGPT account its own tunnel and Runtime API key, then run them side by side.", sections: ["tunnels"] },
    { id: "security", title: "Security and architecture", description: "See how Coworker protects credentials, routes MCP traffic and asks for approval.", sections: ["security", "troubleshooting"] },
    { id: "changelog", title: "Changelog", description: "Public Coworker releases.", sections: ["changelog"] },
  ];
  const requested = new URLSearchParams(location.search).get("page") || location.hash.slice(1);
  const pageIndex = Math.max(0, pages.findIndex(page => page.id === requested));
  const page = pages[pageIndex];
  const visible = new Set(page.sections);

  document.querySelectorAll(".docs-main > .doc-section").forEach(section => {
    section.hidden = !visible.has(section.id);
    const heading = section.querySelector("h2");
    if (heading) heading.hidden = section.id === page.id;
  });
  const header = document.querySelector(".docs-header");
  header.querySelector("h1").textContent = page.title;
  header.querySelector(".desc").textContent = page.description;
  document.title = `${page.title} — Coworker`;

  document.querySelectorAll(".docs-sidebar a").forEach(link => {
    const target = new URL(link.href).searchParams.get("page") || "overview";
    link.classList.toggle("active", target === page.id);
    if (target === page.id) link.setAttribute("aria-current", "page");
  });
  const pager = document.querySelector(".doc-pager");
  const previous = pager.querySelector("a:first-child");
  const next = pager.querySelector("a.next");
  const before = pages[pageIndex - 1];
  const after = pages[pageIndex + 1];
  previous.href = before ? (before.id === "overview" ? "en.html" : `en.html?page=${before.id}`) : "../index.html";
  previous.querySelector("b").textContent = `← ${before?.label || before?.title || "Home"}`;
  next.href = after ? `en.html?page=${after.id}` : "../index.html";
  next.querySelector("small").textContent = "Next";
  next.querySelector("b").textContent = `${after?.title || "Home"} →`;
})();
