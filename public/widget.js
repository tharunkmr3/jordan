(function() {
  // Get agent ID from script tag
  var script = document.currentScript || document.querySelector('script[data-agent-id]');
  var agentId = script && script.getAttribute('data-agent-id');
  if (!agentId) return;

  var API_URL = script.src.replace('/widget.js', '');
  var conversationId = localStorage.getItem('jordon_conv_' + agentId);
  var isOpen = false;

  // Create widget container
  var container = document.createElement('div');
  container.id = 'jordon-widget';
  container.innerHTML = '\
    <style>\
      #jordon-widget { font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif; position: fixed; bottom: 20px; right: 20px; z-index: 99999; }\
      #jordon-toggle { width: 56px; height: 56px; border-radius: 50%; background: #0a0a0a; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }\
      #jordon-toggle svg { width: 24px; height: 24px; fill: white; }\
      #jordon-chat { display: none; width: 380px; height: 520px; background: white; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.12); border: 1px solid #e5e5e5; position: absolute; bottom: 68px; right: 0; flex-direction: column; overflow: hidden; }\
      #jordon-chat.open { display: flex; }\
      #jordon-header { padding: 16px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px; }\
      #jordon-header-title { font-size: 14px; font-weight: 600; }\
      #jordon-header-status { font-size: 11px; color: #22c55e; }\
      #jordon-close { background: none; border: none; cursor: pointer; margin-left: auto; font-size: 18px; color: #999; }\
      #jordon-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }\
      .jordon-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; word-wrap: break-word; }\
      .jordon-msg-user { align-self: flex-end; background: #0a0a0a; color: white; border-bottom-right-radius: 4px; }\
      .jordon-msg-bot { align-self: flex-start; background: #f5f5f5; color: #0a0a0a; border-bottom-left-radius: 4px; }\
      .jordon-msg-loading { align-self: flex-start; background: #f5f5f5; color: #999; }\
      #jordon-input-area { padding: 12px; border-top: 1px solid #f0f0f0; display: flex; gap: 8px; }\
      #jordon-input { flex: 1; border: 1px solid #e5e5e5; border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; font-family: inherit; }\
      #jordon-input:focus { border-color: #999; }\
      #jordon-send { width: 36px; height: 36px; border-radius: 8px; background: #0a0a0a; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }\
      #jordon-send svg { width: 16px; height: 16px; fill: white; }\
      #jordon-powered { text-align: center; padding: 6px; font-size: 10px; color: #ccc; }\
      #jordon-powered a { color: #999; text-decoration: none; }\
    </style>\
    <div id="jordon-chat">\
      <div id="jordon-header">\
        <div>\
          <div id="jordon-header-title">AI Assistant</div>\
          <div id="jordon-header-status">\u25CF Online</div>\
        </div>\
        <button id="jordon-close">\u00D7</button>\
      </div>\
      <div id="jordon-messages"></div>\
      <div id="jordon-input-area">\
        <input id="jordon-input" placeholder="Type a message..." />\
        <button id="jordon-send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>\
      </div>\
      <div id="jordon-powered">Powered by <a href="https://jordon.ai" target="_blank">Jordon</a></div>\
    </div>\
    <button id="jordon-toggle"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg></button>\
  ';
  document.body.appendChild(container);

  // Toggle chat
  document.getElementById('jordon-toggle').onclick = function() {
    isOpen = !isOpen;
    document.getElementById('jordon-chat').classList.toggle('open', isOpen);
    if (isOpen && !document.getElementById('jordon-messages').children.length) {
      loadHistory();
    }
  };
  document.getElementById('jordon-close').onclick = function() {
    isOpen = false;
    document.getElementById('jordon-chat').classList.remove('open');
  };

  // Send message
  function sendMessage() {
    var input = document.getElementById('jordon-input');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';

    appendMessage(msg, 'user');
    appendMessage('...', 'loading');

    fetch(API_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId, message: msg, conversationId: conversationId }),
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var msgs = document.getElementById('jordon-messages');
        var loading = msgs.querySelector('.jordon-msg-loading');
        if (loading) loading.remove();

        appendMessage(data.response, 'bot');
        conversationId = data.conversationId;
        localStorage.setItem('jordon_conv_' + agentId, conversationId);
      })
      .catch(function() {
        var msgs = document.getElementById('jordon-messages');
        var loading = msgs.querySelector('.jordon-msg-loading');
        if (loading) loading.remove();
        appendMessage('Sorry, something went wrong. Please try again.', 'bot');
      });
  }

  document.getElementById('jordon-send').onclick = sendMessage;
  document.getElementById('jordon-input').onkeydown = function(e) {
    if (e.key === 'Enter') sendMessage();
  };

  function appendMessage(text, type) {
    var msgs = document.getElementById('jordon-messages');
    var div = document.createElement('div');
    div.className = 'jordon-msg jordon-msg-' + type;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function loadHistory() {
    if (conversationId) {
      fetch(API_URL + '/api/chat/history?conversationId=' + conversationId)
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.messages) {
            data.messages.forEach(function(m) {
              appendMessage(m.content, m.role === 'user' ? 'user' : 'bot');
            });
          }
        })
        .catch(function() {
          // Ignore — just show empty chat
        });
    }
  }
})();
