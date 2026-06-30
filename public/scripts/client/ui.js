// public/scripts/client/ui.js

// highlight active room
function updateActiveRoomUI(activeRoom) {
  const items = document.querySelectorAll(".room-item");
  items.forEach(item => {
    if (item.dataset.room === activeRoom) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

// remove variation selector characters
function cleanMessage(text) {
  return text.replace(/\uFE0F/g, '');
}

// format timestamp to readable date
function formatDate(timestamp) {
    const date = new Date(timestamp);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

// decode html entities
function decodeHtmlEntities(text) {
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// parse formatting tags safely
function appendParsedText(container, text) {
    const regex = /(<br>|<b>|<\/b>|<a\s+href="[^"]*">|<\/a>|<img\s+src="[^"]*">|<audio\s+src="[^"]*">)/gi;
    const parts = text.split(regex);
    
    let currentContainer = container;
    const stack = []; 

    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        if (part === undefined || part === "") continue;

        if (i % 2 === 1) { 
            const matchStr = part.toLowerCase();
            
            if (matchStr === '<br>') {
                currentContainer.appendChild(document.createElement('br'));
            } else if (matchStr === '<b>') {
                const b = document.createElement('b');
                currentContainer.appendChild(b);
                stack.push({ type: 'b', element: b, parent: currentContainer });
                currentContainer = b;
            } else if (matchStr === '</b>') {
                let found = false;
                for (let j = stack.length - 1; j >= 0; j--) {
                    if (stack[j].type === 'b') {
                        const popped = stack.splice(j);
                        currentContainer = popped[0].parent;
                        found = true;
                        break;
                    }
                }
                if (!found) currentContainer.appendChild(document.createTextNode(decodeHtmlEntities(part)));
            } else if (matchStr.startsWith('<a ')) {
                const urlMatch = part.match(/^<a\s+href="([^"]*)">$/i);
                if (urlMatch) {
                    const url = urlMatch[1];
                    const a = document.createElement('a');
                    a.href = `/redirect.html?url=${encodeURIComponent(url)}`;
                    a.target = "_blank";
                    currentContainer.appendChild(a);
                    stack.push({ type: 'a', element: a, parent: currentContainer });
                    currentContainer = a;
                } else {
                    currentContainer.appendChild(document.createTextNode(decodeHtmlEntities(part)));
                }
            } else if (matchStr === '</a>') {
                let found = false;
                for (let j = stack.length - 1; j >= 0; j--) {
                    if (stack[j].type === 'a') {
                        const popped = stack.splice(j);
                        currentContainer = popped[0].parent;
                        found = true;
                        break;
                    }
                }
                if (!found) currentContainer.appendChild(document.createTextNode(decodeHtmlEntities(part)));
            } else if (matchStr.startsWith('<img ')) {
                const imgMatch = part.match(/^<img\s+src="([^"]*)">$/i);
                if (imgMatch) {
                    const src = imgMatch[1];
                    const img = document.createElement('img');
                    img.src = src;
                    img.style.maxWidth = '80%';
                    img.style.height = 'auto';
                    img.style.display = 'block';
                    img.style.marginTop = '8px';
                    img.style.marginBottom = '8px';
                    img.style.borderRadius = '4px';
                    
                    img.onload = () => {
                        if (typeof chatWindow !== 'undefined') {
                            const isNearBottom = chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight < (img.clientHeight + 100);
                            if (isNearBottom) {
                                chatWindow.scrollTop = chatWindow.scrollHeight;
                            }
                        }
                    };
                    
                    currentContainer.appendChild(img);
                } else {
                    currentContainer.appendChild(document.createTextNode(decodeHtmlEntities(part)));
                }
            } else if (matchStr.startsWith('<audio ')) {
                const audioMatch = part.match(/^<audio\s+src="([^"]*)">$/i);
                if (audioMatch) {
                    const src = audioMatch[1];
                    
                    const wrapper = document.createElement('div');
                    wrapper.className = 'custom-audio-player';

                    const playBtn = document.createElement('button');
                    playBtn.className = 'audio-play-btn';
                    playBtn.innerHTML = '▶';

                    const progressContainer = document.createElement('div');
                    progressContainer.className = 'audio-progress';
                    const progressBar = document.createElement('div');
                    progressBar.className = 'audio-progress-bar';
                    progressContainer.appendChild(progressBar);

                    const timeDisplay = document.createElement('span');
                    timeDisplay.className = 'audio-time';
                    timeDisplay.innerText = '0:00 / 0:00';

                    const volWrapper = document.createElement('div');
                    volWrapper.className = 'audio-vol-wrapper';

                    const volIcon = document.createElement('span');
                    volIcon.className = 'audio-vol-icon';
                    volIcon.innerText = '🕪';

                    const volPopup = document.createElement('div');
                    volPopup.className = 'audio-vol-popup';

                    const volSlider = document.createElement('input');
                    volSlider.type = 'range';
                    volSlider.min = '0';
                    volSlider.max = '1';
                    volSlider.step = '0.01';
                    volSlider.value = '1';

                    volPopup.appendChild(volSlider);
                    volWrapper.appendChild(volIcon);
                    volWrapper.appendChild(volPopup);

                    const audioEl = document.createElement('audio');
                    audioEl.src = src;
                    audioEl.preload = 'metadata';
                    audioEl.style.display = 'none';

                    wrapper.appendChild(playBtn);
                    wrapper.appendChild(progressContainer);
                    wrapper.appendChild(timeDisplay);
                    wrapper.appendChild(volWrapper);
                    wrapper.appendChild(audioEl);

                    // format time helper
                    const formatTime = (time) => {
                        if (isNaN(time)) return '0:00';
                        const m = Math.floor(time / 60);
                        const s = String(Math.floor(time % 60)).padStart(2, '0');
                        return `${m}:${s}`;
                    };

                    const updateVolIcon = (vol) => {
                        if (vol === 0) return '🕨';
                        if (vol < 0.5) return '🕩';
                        return '🕪';
                    };

                    // logic
                    playBtn.onclick = () => {
                        if (audioEl.paused) {
                            audioEl.play();
                            playBtn.innerHTML = '⏸';
                        } else {
                            audioEl.pause();
                            playBtn.innerHTML = '▶';
                        }
                    };

                    volIcon.onclick = () => {
                        if (audioEl.volume > 0) {
                            audioEl.dataset.lastVol = audioEl.volume;
                            audioEl.volume = 0;
                            volSlider.value = 0;
                        } else {
                            const lastVol = parseFloat(audioEl.dataset.lastVol) || 1;
                            audioEl.volume = lastVol;
                            volSlider.value = lastVol;
                        }
                        volIcon.innerText = updateVolIcon(audioEl.volume);
                    };

                    volSlider.oninput = (e) => {
                        audioEl.volume = parseFloat(e.target.value);
                        volIcon.innerText = updateVolIcon(audioEl.volume);
                    };

                    audioEl.onended = () => {
                        playBtn.innerHTML = '▶';
                        progressBar.style.width = '0%';
                        timeDisplay.innerText = `0:00 / ${formatTime(audioEl.duration)}`;
                    };

                    audioEl.ontimeupdate = () => {
                        if (audioEl.duration) {
                            const percent = (audioEl.currentTime / audioEl.duration) * 100;
                            progressBar.style.width = percent + '%';
                            timeDisplay.innerText = `${formatTime(audioEl.currentTime)} / ${formatTime(audioEl.duration)}`;
                        }
                    };

                    audioEl.onloadedmetadata = () => {
                        timeDisplay.innerText = `0:00 / ${formatTime(audioEl.duration)}`;
                        if (typeof chatWindow !== 'undefined') {
                            const isNearBottom = chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight < (wrapper.clientHeight + 100);
                            if (isNearBottom) {
                                chatWindow.scrollTop = chatWindow.scrollHeight;
                            }
                        }
                    };

                    progressContainer.onclick = (e) => {
                        if (audioEl.duration) {
                            const rect = progressContainer.getBoundingClientRect();
                            const clickX = e.clientX - rect.left;
                            const percent = clickX / rect.width;
                            audioEl.currentTime = percent * audioEl.duration;
                        }
                    };

                    currentContainer.appendChild(wrapper);
                } else {
                    currentContainer.appendChild(document.createTextNode(decodeHtmlEntities(part)));
                }
            } else {
                currentContainer.appendChild(document.createTextNode(decodeHtmlEntities(part)));
            }
        } else { 
            currentContainer.appendChild(document.createTextNode(decodeHtmlEntities(part)));
        }
    }
}

// render message to chat window
function addMessage(sender, text, type, timestamp = Date.now(), msgId = null, method = "append", isDeleted = false, isCensored = false, isBridged = false) {
    // update existing message if found
    if (msgId) {
        const existingDiv = document.querySelector(`.message[data-msg-id="${msgId}"]`);
        if (existingDiv) {
            const contentDiv = existingDiv.lastElementChild;
            if (contentDiv) {
                const cleanedText = cleanMessage(text);
                contentDiv.innerHTML = ""; 
                appendParsedText(contentDiv, cleanedText);
                
                if (isDeleted || isCensored) {
                    contentDiv.style.color = "var(--comment-color)";
                }
            }
            return;
        }
    }

    const div = document.createElement('div');
    div.className = 'message';
    div.style.marginBottom = "10px"; 
    if (msgId) {
        div.dataset.msgId = msgId;
    }
    
    text = cleanMessage(text);
    
    // create message header
    const headerDiv = document.createElement('div');
    headerDiv.style.marginBottom = "3px";
    headerDiv.style.lineHeight = "1.4";

    const senderSpan = document.createElement('span');
    senderSpan.textContent = sender; 
    senderSpan.style.marginRight = "10px";
    senderSpan.style.fontWeight = "bold";
    
    if (sender === currentUser) {
        senderSpan.style.color = "var(--my-nom-color)";

    } else if (sender === "system" || sender === "caffeine" || sender === "console" || sender === "newsbot") {
        senderSpan.style.color = "var(--admin-nom-color)";
    } else if (sender === "EnderDragon") {
        senderSpan.style.color = "var(--dragon-nom-color)";
    } else {
        senderSpan.style.color = "var(--nom-color)";
    }

    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatDate(timestamp);
    timeSpan.style.color = "var(--comment-color)";
    timeSpan.style.fontSize = "0.85em";
    timeSpan.style.fontFamily = "'unifont', monospace";

    let bridgeCheckmark = null;
    if (isBridged) {
        bridgeCheckmark = document.createElement('span');
        bridgeCheckmark.className = "bridge-success-mark";
        bridgeCheckmark.textContent = "✓";
        bridgeCheckmark.style.color = "var(--success-color, #347b68)";
        bridgeCheckmark.style.marginLeft = "5px";
        bridgeCheckmark.style.fontSize = "0.85em";
        bridgeCheckmark.title = "synced";
    }

    const copySpan = document.createElement('span');
    copySpan.textContent = "#";
    copySpan.className = "msg-id-copy";
    
    if (msgId) {
        copySpan.addEventListener('click', () => {
            navigator.clipboard.writeText(msgId).then(() => {
                const originalText = copySpan.textContent;
                copySpan.textContent = "✓";
                setTimeout(() => {
                    copySpan.textContent = originalText;
                }, 1000);
            }).catch(err => {
                console.error('failed to copy:', err);
            });
        });
    }

    headerDiv.appendChild(senderSpan);
    headerDiv.appendChild(timeSpan);
    if (bridgeCheckmark) headerDiv.appendChild(bridgeCheckmark);
    if (msgId) headerDiv.appendChild(copySpan);

    // create message content
    const contentDiv = document.createElement('div');
    contentDiv.style.wordBreak = "break-word"; 
    contentDiv.style.lineHeight = "1.4";
    contentDiv.style.fontWeight = "normal";
    
    if (isDeleted || isCensored) {
        contentDiv.style.color = "var(--comment-color)";
    }

    appendParsedText(contentDiv, text);

    div.appendChild(headerDiv);
    div.appendChild(contentDiv);

    if (method === "prepend") {
        chatWindow.prepend(div);
    } else {
        // smart auto-scroll logic
        const isNearBottom = chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight < 100;
        
        chatWindow.appendChild(div);
        
        if (isNearBottom || sender === currentUser) {
            chatWindow.scrollTop = chatWindow.scrollHeight;
        }
    }
}
