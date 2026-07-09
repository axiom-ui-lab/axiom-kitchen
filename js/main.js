let audioCtx = null;
let analyser = null;
let dataArray = null;
let animationId = null;
let streamReference = null;
let selectedVoice = null;
let sourceNode = null;
let baselineNoise = 0;
let baselineFrames = 0;
let noiseFloor = 0;
let dynamicNoiseFloor = 255;
let frameCount = 0;
let calibrationMin = 255;
let calibrationValues = [];
let speechPrimed = false;
let audioWarmupDone = false;
let speechWarmupDone = false;

let audioCuesPrepared = false;
let cueAudioCtx = null;
let lastAudioCueSource = null;
let audioCueWarmupPromise = null;
let mobileEndCueStamp = 0;
let firefoxPointerCueKey = null;
let firefoxPointerCueStamp = 0;
let firefoxPointerCueConsumed = false;
let mobilePointerCueKey = null;
let mobilePointerCueStamp = 0;
let mobilePointerCueConsumed = false;
let mobileStartCueStamp = 0;
let mobileCueGestureStamp = 0;


const BASELINE_SAMPLES = 30;
const AUDIO_CUE_KEYS = ['start', 'end'];
const audioCueCache = Object.create(null);
const audioCueBufferCache = Object.create(null);
const audioCueBufferPromises = Object.create(null);
const audioCueArrayBufferCache = Object.create(null);
const audioCueArrayBufferPromises = Object.create(null);

const FIREFOX_POINTER_CUE_GUARD_MS = 900;
const MOBILE_POINTER_CUE_GUARD_MS = 1100;
const MOBILE_TAP_DUPLICATE_GUARD_MS = 450;
const MOBILE_END_CUE_GUARD_MS = 1200;

const MOBILE_UA_RE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
const IS_IPAD_DESKTOP_UA = /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
const IS_MOBILE_LIKE_DEVICE = MOBILE_UA_RE.test(navigator.userAgent) || IS_IPAD_DESKTOP_UA;
const IS_FIREFOX_DESKTOP = /Firefox/i.test(navigator.userAgent) && !IS_MOBILE_LIKE_DEVICE;

// ============================================================
if(!document.querySelector('#dynamic-shake-keyframes'))
    {
        const style = document.createElement('style');
        style.id = 'dynamic-shake-keyframes';
        style.textContent = 
        `
            @keyframes shake-anim
            {
                0%, 100%{transform:translate3d(0, 0, 0);}
                20%, 60%{transform:translate3d(-8px, 0, 0);}
                40%, 80%{transform:translate3d(8px, 0, 0);}
            }
        `;
        document.head.appendChild(style);
}

// ============================================================
function getAudioContextClass()
{
    return window.AudioContext || window['webkitAudioContext'] || window['msAudioContext'] || null;
}

// ============================================================
function getCueAudioContext()
{
    if(cueAudioCtx && cueAudioCtx.state !== 'closed') return cueAudioCtx;

    const AudioContextClass = getAudioContextClass();
    if(!AudioContextClass) return null;

    try
    {
        if(IS_FIREFOX_DESKTOP)
            {
                cueAudioCtx = new AudioContextClass();
                return cueAudioCtx;
            }

        cueAudioCtx = audioCtx && audioCtx.state !== 'closed' ? audioCtx : new AudioContextClass();

        if(!audioCtx || audioCtx.state === 'closed')
            {
                audioCtx = cueAudioCtx;
            }
        return cueAudioCtx;
    }
    catch(e)
    {
        console.warn('Cue AudioContext creation failed:', e);
        return null;
    }
}

// ============================================================
async function resumeAudioContexts()
{
    const resumeOne = async (ctx, label) => 
        {
            if(!ctx || ctx.state === 'closed') return false;
            if(ctx.state === 'suspended' || ctx.state === 'interrupted')
                {
                    try
                    {
                        await ctx.resume();
                    }
                    catch(e)
                    {
                        console.warn(`${label} AudioContext resume failed:`, e);
                    }
                }
            return ctx.state === 'running';
        };

    const cueCtx = getCueAudioContext();
    const cueRunning = await resumeOne(cueCtx, 'Cue');
    if(audioCtx && audioCtx !== cueCtx)
        {
            await resumeOne(audioCtx, 'Main');
        }

    return cueRunning || (!!cueCtx && cueCtx.state === 'running');
}

// ============================================================
function createAudioCue(key)
{
    const audio = document.createElement('audio');

    audio.src = `./${key}.mp3`;
    audio.preload = 'auto';
    audio.volume = 1.0;
    audio.muted = false;
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');

    audio.style.display = 'none';

    if(document.body && !audio.isConnected)
        {
            document.body.appendChild(audio);
        }

    try
    {
        audio.load();
    }
    catch(e)
    {
        console.warn(`Audio cue preload failed for ${key}:`, e);
    }

    return audio;
}

// ============================================================
function getAudioCue(key)
{
    if(!AUDIO_CUE_KEYS.includes(key)) return null;

    if(!audioCueCache[key])
        {
            audioCueCache[key] = createAudioCue(key);
        }

    return audioCueCache[key];
}

// ============================================================
function preloadAudioCueBytes(key)
{
    if(!AUDIO_CUE_KEYS.includes(key)) return Promise.resolve(null);

    if(audioCueArrayBufferCache[key])
        {
            return Promise.resolve(audioCueArrayBufferCache[key]);
        }

    if(audioCueArrayBufferPromises[key])
        {
            return audioCueArrayBufferPromises[key];
        }

    if(typeof fetch !== 'function')
        {
            return Promise.resolve(null);
        }

    audioCueArrayBufferPromises[key] = fetch(`./${key}.mp3`, {cache: 'force-cache'})
    .then((response) => 
        {
            if(!response.ok)
                {
                    throw new Error(`HTTP ${response.status} while preloading ${key}.mp3`);
                }
                return response.arrayBuffer();
        })
        .then((arrayBuffer) => 
            {
                audioCueArrayBufferCache[key] = arrayBuffer;
                return arrayBuffer;
            })
            .catch((e) =>
                {
                    console.warn(`Audio cue byte preload failed for ${key}:`, e);
                    delete audioCueArrayBufferPromises[key];
                    return null;
                });
        return audioCueArrayBufferPromises[key];
}

// ============================================================
function decodeCueAudioData(ctx, arrayBuffer)
{
    if(!ctx || !arrayBuffer) return Promise.resolve(null);

    try
    {
        const promise = ctx.decodeAudioData(arrayBuffer.slice(0));

        if(promise && typeof promise.then === 'function')
            {
                return promise;
            }
    }
    catch(e){}

    return new Promise((resolve, reject) => 
        {
            try
            {
                ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
            }
            catch(e)
            {
                reject(e);
            }
        });
}

// ============================================================
function loadAudioCueBuffer(key)
{
    if(!AUDIO_CUE_KEYS.includes(key)) return Promise.resolve(null);

    if(audioCueBufferCache[key])
        {
            return Promise.resolve(audioCueBufferCache[key]);
        }

    if(audioCueBufferPromises[key])
        {
            return audioCueBufferPromises[key];
        }

    const ctx = getCueAudioContext();

    if(!ctx)
        {
            return Promise.resolve(null);
        }

    audioCueBufferPromises[key] = (async () =>
        {
            let arrayBuffer = audioCueArrayBufferCache[key];

            if(!arrayBuffer)
                {
                    arrayBuffer = await preloadAudioCueBytes(key);
                }

            if(!arrayBuffer)
                {
                    throw new Error(`No ArrayBuffer available for ${key}.mp3`);
                }

            const decodedBuffer = await decodeCueAudioData(ctx, arrayBuffer);

            if(!decodedBuffer)
                {
                    throw new Error(`decodeAudioData returned no buffer for ${key}.mp3`);
                }

            audioCueBufferCache[key] = decodedBuffer;
            return decodedBuffer;
        })()
        .catch((e) =>
            {
                console.warn(`Web Audio cue decode failed for ${key}:`, e);
                delete audioCueBufferPromises[key];
                return null;
            });

    return audioCueBufferPromises[key];
}

// ============================================================
function prepareAudioCues()
{
    if(audioCuesPrepared) return;

    AUDIO_CUE_KEYS.forEach((key) =>
        {
            getAudioCue(key);
            preloadAudioCueBytes(key);
        });

    audioCuesPrepared = true;
}

// ============================================================
function warmAudioCueBuffers()
{
    if(audioCueWarmupPromise) return audioCueWarmupPromise;

    audioCueWarmupPromise = (async () => 
        {
            prepareAudioCues();

            const ctx = getCueAudioContext();
            if(!ctx)
                {
                    audioCueWarmupPromise = null;
                    return false;
                }

            await resumeAudioContexts();

            const buffers = await Promise.all
                (
                    AUDIO_CUE_KEYS.map((key) => loadAudioCueBuffer(key))
                );

            const allReady = buffers.every(Boolean);

            if(!allReady)
                {
                    audioCueWarmupPromise = null;
                }

            return allReady;
        })()
        .catch((e) =>
            {
                console.warn('Audio cue warmup failed:', e);
                audioCueWarmupPromise = null;
                return false;
            });

    return audioCueWarmupPromise;
}

// ============================================================
function resetAudioCue(audio)
{
    if(!audio) return;

    try
    {
        audio.pause();
    }
    catch(e)
    {
        console.warn('Audio cue pause failed:', e);
    }

    try
    {
        audio.currentTime = 0;
    }
    catch(e)
    {
        console.warn('Audio cue currentTime reset failed:', e);
    }

    audio.muted = false;
    audio.volume = 1.0;
}

// ============================================================
async function playHtmlAudioCue(key)
{
    const audio = getAudioCue(key);
    if(!audio) return false;

    try
    {
        resetAudioCue(audio);
        const playPromise = audio.play();
        
        if(playPromise && typeof playPromise.then === 'function')
            {
                await playPromise;
            }
        return true;
    }
    catch(e)
    {
        console.warn(`HTML audio cue blocked or failed for ${key}:`, e);
        return false;
    }
}

// ============================================================
function playMobileEndCueNow()
{
    if(!IS_MOBILE_LIKE_DEVICE) return false;

    prepareAudioCues();
    mobileEndCueStamp = Date.now();

    void playHtmlAudioCue('end');
    return true;
}

// ============================================================
function playFirefoxDesktopGestureCue(key)
{
    if(!IS_FIREFOX_DESKTOP) return false;
    if(!AUDIO_CUE_KEYS.includes(key)) return false;

    prepareAudioCues();

    const audio = getAudioCue(key);
    if(!audio) return false;

    try
    {
        resetAudioCue(audio);

        audio.muted = false;
        audio.volume = 1.0;

        firefoxPointerCueKey = key;
        firefoxPointerCueStamp = Date.now();
        firefoxPointerCueConsumed = false;

        const playPromise = audio.play();

        if(playPromise && typeof playPromise.then === 'function')
            {
                playPromise
                .then(() =>
                    {
                        setTimeout(() =>
                            {
                                if(firefoxPointerCueKey === key && Date.now() - firefoxPointerCueStamp >= FIREFOX_POINTER_CUE_GUARD_MS)
                                    {
                                        firefoxPointerCueKey = null;
                                        firefoxPointerCueStamp = 0;
                                        firefoxPointerCueConsumed = false;
                                    }
                            }, FIREFOX_POINTER_CUE_GUARD_MS);
                    })
                .catch((e) =>
                    {
                        if(firefoxPointerCueKey === key)
                            {
                                firefoxPointerCueKey = null;
                                firefoxPointerCueStamp = 0;
                                firefoxPointerCueConsumed = false;
                            }
                        console.warn(`Firefox Desktop immediate audio cue failed for ${key}:`, e);
                    });
            }
        return true;
    }
    catch(e)
    {
        firefoxPointerCueKey = null;
        firefoxPointerCueStamp = 0;
        firefoxPointerCueConsumed = false;

        console.warn(`Firefox Desktop immediate audio cue threw for ${key}:`, e);
        return false;
    }
}

// ============================================================
function playMobileGestureCue(key)
{
    if(!IS_MOBILE_LIKE_DEVICE || !AUDIO_CUE_KEYS.includes(key)) return false;

    const audio = getAudioCue(key);
    if(!audio) return false;

    try
    {
        resetAudioCue(audio);

        audio.muted = false;
        audio.volume = 1.0;
        audio.playsInline = true;
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');

        mobilePointerCueKey = key;
        mobilePointerCueStamp = Date.now();
        mobilePointerCueConsumed = false;
        if(key === 'end') mobileEndCueStamp = mobilePointerCueStamp;

        const playPromise = audio.play();
        if(playPromise && typeof playPromise.catch === 'function')
        {
            playPromise.catch(e => console.warn(`Mobile immediate audio cue failed for ${key}:`, e));
        }
        return true;
    }
    catch(e)
    {
        mobilePointerCueKey = null;
        mobilePointerCueStamp = 0;
        mobilePointerCueConsumed = false;
        console.warn(`Mobile immediate audio cue threw for ${key}:`, e);
        return false;
    }
}

// ============================================================
async function playAudio(key, waitForBuffer = false)
{
    if(!AUDIO_CUE_KEYS.includes(key)) return false;

    if(IS_FIREFOX_DESKTOP && firefoxPointerCueKey === key && !firefoxPointerCueConsumed && Date.now() - firefoxPointerCueStamp < FIREFOX_POINTER_CUE_GUARD_MS)
        {
            firefoxPointerCueConsumed = true;
            return true;
        }
    
    if(IS_MOBILE_LIKE_DEVICE && key === 'start' && mobilePointerCueKey === key && !mobilePointerCueConsumed && Date.now() - mobilePointerCueStamp < MOBILE_POINTER_CUE_GUARD_MS)
        {
            mobilePointerCueConsumed = true;
        }

    prepareAudioCues();
    const ctx = getCueAudioContext();
    await resumeAudioContexts();
    let buffer = audioCueBufferCache[key];

    if(ctx && ctx.state === 'running' && !buffer)
        {
            if(waitForBuffer)
                {
                    buffer = await loadAudioCueBuffer(key);
                }
            else
                {
                    void loadAudioCueBuffer(key);
                }
        }

    if(ctx && ctx.state === 'running' && buffer)
        {
            try
            {
                if(lastAudioCueSource)
                    {
                        try
                        {
                            lastAudioCueSource.stop(0);
                        }
                        catch(e){}

                        lastAudioCueSource = null;
                    }

                const source = ctx.createBufferSource();
                const gainNode = ctx.createGain();

                source.buffer = buffer;
                gainNode.gain.value = 1.0;

                source.connect(gainNode);
                gainNode.connect(ctx.destination);

                source.onended = () =>
                    {
                        if(lastAudioCueSource === source)
                            {
                                lastAudioCueSource = null;
                            }

                        try
                        {
                            source.disconnect();
                            gainNode.disconnect();
                        }
                        catch(e){}
                    };

                source.start(0);
                lastAudioCueSource = source;

                return true;
            }
            catch(e)
            {
                console.warn(`Web Audio cue failed for ${key}:`, e);
            }
        }

    return await playHtmlAudioCue(key);
}

// ============================================================
window.attemptReconnect = function()
{
    const btn = document.querySelector('.retry-btn');
    const offlineScreen = document.getElementById('offline-screen');
    if(!btn) return;

    if(navigator.onLine)
        {
            btn.style.setProperty('background-color', '#22c55e', 'important');
            btn.style.setProperty('color', '#ffffff', 'important');
            btn.style.setProperty('border-color', '#22c55e', 'important');
            btn.innerHTML = "اتصال برقرار شد! 🎉";
            
            setTimeout(() => 
                {
                    if(offlineScreen)
                        {
                            offlineScreen.style.opacity = '0'; 
                            setTimeout(() => 
                                {
                                    window.location.reload();
                                }, 500);
                        }
                }, 1000);
        }
        else
            {
                btn.classList.remove('shake-anim');
                void btn.offsetWidth;
                btn.classList.add('shake-anim');

                btn.style.setProperty('background-color', '#ff4444', 'important');
                btn.innerHTML = "هنوز متصل نیستید! ❌";

                setTimeout(() => 
                    {
                        btn.classList.remove('shake-anim');
                        btn.style.setProperty('background-color', 'rgba(255, 255, 255, 0.05)', 'important');
                        btn.innerHTML = "تلاش دوباره";
                    }, 1500);
            }
};

// ============================================================
const networkHandler = () => 
{
    const offlineScreen = document.getElementById('offline-screen');
    if(!offlineScreen) return;

    if(!navigator.onLine)
        {
            offlineScreen.style.display = 'flex';
            offlineScreen.classList.remove('fade-out');
            console.log('Offline mode: showing offline screen');
        }
};

window.addEventListener('offline', networkHandler);

// ============================================================
function loadVoices()
{
    if(!('speechSynthesis' in window)) return;

    const voices = speechSynthesis.getVoices();
    if(voices.length > 0)
        {
            selectedVoice = voices.find(v => v.lang.includes('en')) || voices[0];
        }
}

if('speechSynthesis' in window && speechSynthesis.onvoiceschanged !== undefined)
    {
        speechSynthesis.onvoiceschanged = loadVoices;
    }

loadVoices();

// ============================================================
function warmAudioOnFirstTouch()
{
    if(audioWarmupDone) return;
    audioWarmupDone = true;

    document.removeEventListener('click', warmAudioOnFirstTouch);
    document.removeEventListener('touchstart', warmAudioOnFirstTouch);

    const AudioContextClass = window.AudioContext || window['webkitAudioContext'] || window['msAudioContext'];
    if(!AudioContextClass) return;

    const tempCtx = new AudioContextClass();
    tempCtx.resume().then(() => 
        {
            const buf = tempCtx.createBuffer(1, 1, tempCtx.sampleRate);
            const src = tempCtx.createBufferSource();
            src.buffer = buf;
            src.connect(tempCtx.destination);
            src.start(0);
            src.onended = () => tempCtx.close();
        }).catch(() => {});
}
document.addEventListener('click', warmAudioOnFirstTouch, {once:true, passive:true});
document.addEventListener('touchstart', warmAudioOnFirstTouch, {once:true, passive:true});

// ============================================================
function warmSpeechEngine()
{
    if(!('speechSynthesis' in window) || speechPrimed) return;
    const voices = speechSynthesis.getVoices();
    if(voices.length > 0)
        {
            const dummy = new SpeechSynthesisUtterance('');
            dummy.volume = 0;
            speechSynthesis.cancel();
            speechPrimed = true;
        }
}
window.addEventListener('DOMContentLoaded', warmSpeechEngine, { once: true });

// ============================================================
function warmSpeechEngineForDesktop()
{
    if(speechWarmupDone) return;
    if(!('speechSynthesis' in window)) return;
    if(IS_MOBILE_LIKE_DEVICE) return;
    
    try
    {
        const utterance = new SpeechSynthesisUtterance('test');
        utterance.volume = 0;
        utterance.rate = 1;
        utterance.pitch = 1;
        let started = false;
        utterance.onstart = () => 
            {
                started = true;
                speechSynthesis.cancel();
                speechWarmupDone = true;
            };
        
        utterance.onerror = () => 
            {
                speechWarmupDone = true;
            };
        
        speechSynthesis.speak(utterance);
        setTimeout(() => 
            {
                if(!started && !speechWarmupDone)
                    {
                        speechSynthesis.cancel();
                        speechWarmupDone = true;
                    }
            }, 1000);
    }
    catch(e)
    {
        console.warn('Speech warmup failed:', e);
        speechWarmupDone = true;
    }
}

// ============================================================
if(/Firefox/i.test(navigator.userAgent) && /Mobile/i.test(navigator.userAgent))
    {
        const style = document.createElement('style');
        style.textContent = `html .offline-core::after, html .offline-core::before{animation:none !important; opacity:0 !important;}`;
        document.head.appendChild(style);
    }

// ============================================================
(
    function()
    {
        let state = 'idle';
        let startingAudioCues = false;
        let smoothVolume = 0;
        let processingTimeout;
        let lastFocusedElement = null;
        let cachedSpans = null;
        let audioProfile = 'desktop';
        let desktopStartupWatchdog = null;

        // ============================================================
        function clearDesktopStartupWatchdog()
        {
            if(desktopStartupWatchdog)
            {
                clearTimeout(desktopStartupWatchdog);
                desktopStartupWatchdog = null;
            }
        }

        function resetDesktopVisualizerPreState()
        {
            if(IS_MOBILE_LIKE_DEVICE) return;

            if(!cachedSpans || !cachedSpans.length)
                {
                    cachedSpans = document.querySelectorAll('.modern-visualizer span');
                }

            if(cachedSpans && cachedSpans.length)
                {
                    if(!renderFrame.barLevels || renderFrame.barLevels.length !== cachedSpans.length)
                        {
                            renderFrame.barLevels = new Array(cachedSpans.length).fill(0);
                        }
                        else
                            {
                                renderFrame.barLevels.fill(0);
                            }
                            cachedSpans.forEach(span =>
                                {
                                    span.style.height = '4px';
                                    span.style.opacity = '0.5';
                                });
                }
            smoothVolume = 0;
            window.smoothMax = 0;

            if(btn)
                {
                    btn.style.transform = 'scale(1)';
                }
        }

        // ============================================================
        const isMobileLikeDevice = IS_MOBILE_LIKE_DEVICE;
        const isFirefoxDesktop = IS_FIREFOX_DESKTOP;
        const MIC_START_DELAY_MS = isMobileLikeDevice ? 260 : 100;

        const btn = document.getElementById('micBtn');
        const label = document.getElementById('statusLabel');

        const vault = document.getElementById('recipe-vault');
        const closeVault = document.getElementById('close-vault');
        const titleEl = document.getElementById('recipe-title');
        const listEl = document.getElementById('recipe-ingredients');
        const stepsEl = document.getElementById('recipe-instructions');

        // ============================================================
        function stopMobileListeningInputForCue()
        {
            if(!IS_MOBILE_LIKE_DEVICE) return;

            if(streamReference)
            {
                streamReference.getTracks().forEach(track => track.stop());
                streamReference = null;
            }

            if(sourceNode)
            {
                try
                {
                    sourceNode.disconnect();
                }
                catch(e){}
                sourceNode = null;
            }

            if(analyser)
            {
                try
                {
                    analyser.disconnect();
                }
                catch(e){}
                analyser = null;
            }
        }

        // ============================================================
        const handleMobileCueGesture = () => 
        {
            if(!IS_MOBILE_LIKE_DEVICE) return;
            if(!btn) return;

            const now = Date.now();
            if(now - mobileCueGestureStamp < MOBILE_TAP_DUPLICATE_GUARD_MS) return;
            mobileCueGestureStamp = now;

            if(state === 'idle' || state === 'error')
            {
                mobileStartCueStamp = Date.now();
            }
            else if(state === 'listening')
            {
                stopMobileListeningInputForCue();
            }
        };
        if(btn && IS_MOBILE_LIKE_DEVICE)
            {
                btn.style.touchAction = 'manipulation';
                btn.style.setProperty('-webkit-tap-highlight-color','transparent','important');

                if(window.PointerEvent)
                    {
                        btn.addEventListener('pointerdown', handleMobileCueGesture, {capture:true, passive:true});
                    }
                    else
                        {
                            btn.addEventListener('touchstart', handleMobileCueGesture, {capture:true, passive:true});
                        }
        }

        // ============================================================
        const handleFirefoxDesktopCueGesture = (event) => 
            {
                if(!isFirefoxDesktop) return;
                
                if(!btn) return;

                if(event && (event.type === 'pointerdown' || event.type === 'mousedown'))
                    {
                        if(typeof event.button === 'number' && event.button !== 0) return;
                    }

                if(event && event.type === 'keydown')
                    {
                        if(event.key !== 'Enter' && event.key !== ' ') return;
                    }
            };
            if(btn && isFirefoxDesktop)
                {
                    if(window.PointerEvent)
                        {
                            btn.addEventListener('pointerdown', handleFirefoxDesktopCueGesture, {capture: true});
                        }
                    else
                        {
                            btn.addEventListener('mousedown', handleFirefoxDesktopCueGesture, {capture: true});
                        }
                    btn.addEventListener('keydown', handleFirefoxDesktopCueGesture, {capture: true});
                }
        
        // ============================================================
        function typeWriter(text, element)
        {
            if(!element) return;
            element.innerText = text;
        }
        
        // ============================================================
        function setUI(s)
        {
            state = s;
            
            if(s === 'listening')
                {
                    baselineNoise = 0;
                    baselineFrames = 0;
                    noiseFloor = 0;
                    dynamicNoiseFloor = 120;
                    frameCount = 0;
                    calibrationValues = [];

                    renderFrame.desktopCalibrationArmed = false;
                    renderFrame.desktopWakeUpDone = false;
                    renderFrame.voiceCandidateFrames = 0;
                    renderFrame.voiceReleaseFrames = 0;
                    renderFrame.voiceOpen = false;

                    const isDesktopPreAudioReset = !IS_MOBILE_LIKE_DEVICE;

                    if(isDesktopPreAudioReset)
                        {
                            
                            if(!cachedSpans || !cachedSpans.length)
                                {
                                    cachedSpans = document.querySelectorAll('.modern-visualizer span');
                                }

                                if(cachedSpans && cachedSpans.length)
                                {
                                    if(!renderFrame.barLevels || renderFrame.barLevels.length !== cachedSpans.length)
                                        {
                                            renderFrame.barLevels = new Array(cachedSpans.length).fill(0);
                                        }
                                        else
                                            {
                                                renderFrame.barLevels.fill(0);
                                            }
                                            cachedSpans.forEach(span => 
                                                {
                                                    span.style.height = '4px';
                                                    span.style.opacity = '0.5';
                                                });
                                }
                                if(btn)
                                    {
                                        btn.style.transform = 'scale(1)';
                                    }
                        }
                        else if(renderFrame.barLevels)
                            {
                                renderFrame.barLevels.fill(0);
                            }
                            smoothVolume = 0;
                            window.smoothMax = 0;
                }
                
                if(s !== 'listening')
                    {
                        clearDesktopStartupWatchdog();
                        
                        if(animationId)
                            {
                                cancelAnimationFrame(animationId);
                                animationId = null;
                            }
                        
                        if(cachedSpans)
                            {
                                cachedSpans.forEach(span => 
                                    {
                                        span.style.height = '4px';
                                        span.style.opacity = '0.5';
                                    });
                            }

                        if(btn) btn.style.transform = 'scale(1)';
                    }
                    
                const labels = 
                {
                    listening: 'در حال شنیدن...',
                    processing: 'در حال تحلیل...',
                    error: 'خطا در دسترسی!',
                    idle: ''
                };

            const colors = 
                {
                    listening: 'var(--text-silver)',
                    processing: 'var(--processing-aura)',
                    error: 'var(--burner-fire)',
                    idle: 'transparent'
                };

            typeWriter(labels[s] || '', label);
            if(label) label.style.color = colors[s] || 'transparent';

            if(s === 'listening') renderFrame();
        }
        
        if(btn)
            {
                btn.addEventListener('click', async () => 
                    {
                        if(!IS_MOBILE_LIKE_DEVICE && !speechWarmupDone)
                            {
                                warmSpeechEngineForDesktop();
                            }

                        const body = document.body;
                        const stateAtTap = state;

                        if(startingAudioCues) return;
                        prepareAudioCues();
                        
                        if(isMobileLikeDevice && stateAtTap === 'listening')
                            {
                                stopMobileListeningInputForCue();
                            }
                            else
                                {
                                    await unlockSpeech();
                                }
                                if(stateAtTap === 'idle' || stateAtTap === 'error')
                                    {
                                        if(IS_MOBILE_LIKE_DEVICE)
                                            {
                                                playMobileGestureCue('start');
                                                mobileStartCueStamp = Date.now();
                                            }
                                            else
                                                {
                                                    startingAudioCues = true;
                                                    try
                                                    {
                                                        void playAudio('start', false);
                                                        void warmAudioCueBuffers().then((cuesReady) => 
                                                        {
                                                            if(!cuesReady)
                                                            console.warn('Audio cues were not fully warmed. end.mp3 may fall back to HTML audio.');
                                                        });
                                                    }
                                                    finally
                                                    {
                                                        startingAudioCues = false;
                                                    }
                                                }
                                    }
                            else if(stateAtTap === 'listening')
                                {
                                    if(!isMobileLikeDevice)
                                        {

                                        }
                                }

                        unlockSpeech();
                        
                        if(stateAtTap === 'processing')
                            {
                                clearTimeout(processingTimeout);
                                if(window.speechSynthesis)
                                    {
                                        speechSynthesis.cancel();
                                    }

                                state = 'idle';
                                body.classList.remove('is-listening', 'is-processing', 'is-error');
                                setUI('idle');

                                if(IS_MOBILE_LIKE_DEVICE)
                                    {
                                        playMobileGestureCue('end');}
                                        else
                                            {
                                        void playAudio('end', false);
                                    }
                                    
                                mobileEndCueStamp = Date.now();

                                if(label)
                                    {
                                        typeWriter('عملیات لغو شد', label);
                                        label.setAttribute('style', 'display: flex !important; opacity: 1 !important; visibility: visible !important; color: var(--text-silver) !important;');

                                        setTimeout(() => 
                                            {
                                                if(state === 'idle') label.removeAttribute('style');
                                            }, 2000);
                                    }
                                return;
                            }

                        if(stateAtTap === 'idle' || stateAtTap === 'error')
                            {
                                state = 'listening';                                
                                body.classList.remove('is-processing', 'is-error');

                                resetDesktopVisualizerPreState();

                                body.classList.add('is-listening');
                                setUI('listening');

                                clearDesktopStartupWatchdog();
                                if(!IS_MOBILE_LIKE_DEVICE)
                                {
                                    desktopStartupWatchdog = setTimeout(() =>
                                    {
                                        if(state !== 'listening') return;

                                        if(!analyser || !dataArray)
                                        {
                                            console.warn('Desktop audio startup watchdog: analyser was not ready in time.');

                                            if(streamReference)
                                            {
                                                streamReference.getTracks().forEach(track => track.stop());
                                                streamReference = null;
                                            }

                                            if(sourceNode)
                                            {
                                                try{sourceNode.disconnect();}catch(e){}
                                                sourceNode = null;
                                            }

                                            if(analyser)
                                            {
                                                try{analyser.disconnect();}catch(e){}
                                                analyser = null;
                                            }

                                            state = 'error';
                                            document.body.classList.remove('is-listening');
                                            document.body.classList.add('is-error');
                                            setUI('error');
                                        }
                                    }, 7000);
                                }
                                setTimeout(async () => 
                                    {
                                        try
                                        {
                                            if(state !== 'listening') return;

                                            streamReference = await navigator.mediaDevices.getUserMedia
                                            (
                                                {
                                                    audio:
                                                    {
                                                        echoCancellation: true,
                                                        noiseSuppression: true,
                                                        autoGainControl: true
                                                    }
                                                }
                                            );

                                            const track = streamReference.getAudioTracks()[0];
                                            if(track) track.enabled = true;
                                            const hasAccess = await initAudioMonitor(streamReference);
                                            if(!hasAccess) throw new Error('Audio Monitor Init Failed');

                                            clearDesktopStartupWatchdog();
                                        }
                                        catch(err)
                                        {
                                            console.error('Microphone start failed:', err);
                                            state = 'error';
                                            setUI('error');
                                            body.classList.replace('is-listening', 'is-error');
                                        }
                                    }, MIC_START_DELAY_MS);
                            }
                            else if(stateAtTap === 'listening')
                                {
                                    
                                    if(streamReference)
                                        {
                                            streamReference.getTracks().forEach(track => track.stop());
                                            streamReference = null;
                                        }

                                    if(sourceNode)
                                        {
                                            sourceNode.disconnect();
                                            sourceNode = null;
                                        }   

                                    if(analyser)
                                        {
                                            analyser.disconnect();
                                            analyser = null;
                                        }

                                    state = 'processing';
                                    body.classList.remove('is-listening');
                                    body.classList.add('is-processing');
                                    setUI('processing');

                                    const recipeDatabase = 
                                        [
                                            {
                                                speech:"I suggest a simple Tomato omelette.",
                                                title:"املت گوجه‌فرنگی",
                                                ingredients:["۲ عدد تخم‌مرغ","۱ عدد گوجه بزرگ","نمک و فلفل","روغن"],
                                                steps:"ابتدا گوجه را خرد کرده و سرخ کنید. سپس تخم‌مرغ‌ها را اضافه کرده و هم بزنید تا کاملاً بپزد."
                                            },
                                            {
                                                speech:"How about a fresh Avocado Toast?",
                                                title:"تست آووکادو",
                                                ingredients:["۲ عدد نان تست","۱ عدد آووکادو","آب لیمو","دانه کنجد"],
                                                steps:"آووکادو را له کنید و با آب لیمو مخلوط کنید. آن را روی نان تست بمالید و کنجد بپاشید."
                                            },
                                            {
                                                speech:"A classic Caesar Salad is always a good choice.",
                                                title:"سالاد سزار",
                                                ingredients:["کاهو تازه","سینه مرغ گریل شده","پنیر پارمزان","سس مخصوص"],
                                                steps:"کاهو را خرد کنید. مرغ را برش داده و همراه با پنیر و سس به کاهو اضافه کنید."
                                            },
                                            {
                                                speech:"Let's try a quick Pasta with Garlic and Oil.",
                                                title:"پاستا سیر و روغن",
                                                ingredients:["۲۰۰ گرم پاستا","۳ حبه سیر","روغن زیتون","جعفری"],
                                                steps:"پاستا را بپزید. سیر را در روغن زیتون تفت دهید و سپس پاستا و جعفری را با آن مخلوط کنید."
                                            }
                                        ];
                                    
                                    const PROCESSING_DELAY_MS = 2500;
                                    const randomRecipe = recipeDatabase[Math.floor(Math.random() * recipeDatabase.length)];

                                    clearTimeout(processingTimeout);

                                    processingTimeout = setTimeout(() => 
                                        {
                                            if(state !== 'processing') return; 
                                            
                                            speak(randomRecipe.speech, () => 
                                                {
                                                    if(state !== 'processing') return;

                                                    showRecipe(randomRecipe);
                                                    state = 'idle';
                                                    body.classList.remove('is-processing');
                                                    setUI('idle');
                                                });
                                        }, PROCESSING_DELAY_MS);
                                }
                    });
            }

        // ============================================================
        function showRecipe(data = {})
        {
            if(!data.title || !data.ingredients || !data.steps) return;
            
            titleEl.textContent = data.title;
            titleEl.style.direction = 'rtl';
            
            listEl.innerHTML = data.ingredients.map(item => `<li>${item}</li>`).join('');
            listEl.style.direction = 'rtl';
            
            stepsEl.style.direction = 'rtl';
            stepsEl.innerHTML = `<div style="text-align:right;">${data.steps}</div>`;
            
            vault.classList.add('is-visible');
            vault.setAttribute('aria-hidden', 'false');
            
            closeVault.removeEventListener('click', closeRecipe);
            closeVault.addEventListener('click', closeRecipe);

            setTimeout(() => closeVault.focus(), 500);
        }

        // ============================================================
        function closeRecipe()
        {
            vault.classList.remove('is-visible');
            vault.setAttribute('aria-hidden', 'true');
            
            if(document.activeElement === closeVault)
                {
                    closeVault.blur();
                }

            if(lastFocusedElement)
                {
                    lastFocusedElement.focus();
                }
        }

        // ============================================================
        async function initAudioMonitor(stream)
        {
            try
            {
                if(!audioCtx || (IS_FIREFOX_DESKTOP && audioCtx === cueAudioCtx))
                    {
                        const AudioContextClass = getAudioContextClass();
                        if(!AudioContextClass) throw new Error('Web Audio API not supported');
                        audioCtx = new AudioContextClass();
                    }

                if(audioCtx.state === 'suspended')
                    {
                        await audioCtx.resume();
                    }

                if(audioCtx.state !== 'running')
                    {
                        console.warn('Audio context not running, retrying resume...');
                        await audioCtx.resume();
                    }

                const ua = navigator.userAgent;
                const isMobile = MOBILE_UA_RE.test(ua) || IS_IPAD_DESKTOP_UA;
                const isWindows = /Windows/i.test(ua);

                audioProfile = isMobile ? 'mobile' : 'desktop';
                let gainValue = audioProfile === 'mobile' ? 2.0 : 1.80;
                if(isWindows && audioProfile === 'desktop') gainValue = 1.15;
                await new Promise(resolve => setTimeout(resolve, 50));
                const track = stream.getAudioTracks()[0];

                if(track)
                    {
                        track.enabled = true;
                        if(track.muted) console.warn('Microphone track is muted!');
                    }

                if(sourceNode)
                    {
                        sourceNode.disconnect();
                        sourceNode = null;
                    }

                const source = audioCtx.createMediaStreamSource(stream);
                sourceNode = source;

                const gainNode = audioCtx.createGain();
                gainNode.gain.value = gainValue;

                const highPassFilter = audioCtx.createBiquadFilter();
                highPassFilter.type = 'highpass';
                highPassFilter.frequency.value = audioProfile === 'mobile' ? 80 : 115;
                highPassFilter.Q.value = 0.707;

                const lowPassFilter = audioCtx.createBiquadFilter();
                lowPassFilter.type = 'lowpass';
                lowPassFilter.frequency.value = audioProfile === 'mobile' ? 7600 : 4800;
                lowPassFilter.Q.value = 0.707;

                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = audioProfile === 'mobile' ? 0.22 : 0.12;
                dataArray = new Uint8Array(analyser.frequencyBinCount);

                source.connect(gainNode);
                gainNode.connect(highPassFilter);
                highPassFilter.connect(lowPassFilter);
                lowPassFilter.connect(analyser);

                cachedSpans = document.querySelectorAll('.modern-visualizer span');

                return true;
            }
            catch(e)
            {
                console.error('initAudioMonitor error:', e);
                return false;
            }
        }

        // ============================================================
        function renderFrame()
        {
            if(state !== 'listening') return;

            if(analyser && dataArray && cachedSpans && cachedSpans.length)
                {
                    analyser.getByteFrequencyData(dataArray);

                    const isDesktopProfile = audioProfile === 'desktop';
                    const barCount = cachedSpans.length;
                    const binCount = dataArray.length;

                    if(!renderFrame.barLevels || renderFrame.barLevels.length !== barCount)
                        {
                            renderFrame.barLevels = new Array(barCount).fill(0);
                        }

                    let frameMax = 0;
                    let frameSum = 0;

                    for(let i = 0; i < binCount; i++)
                        {
                            const value = dataArray[i];
                            frameSum += value;
                            if(value > frameMax) frameMax = value;
                        }

                    const frameAverage = frameSum / Math.max(1, binCount);
                    const frameEnergy = isDesktopProfile
                        ? ((frameAverage * 0.64) + (frameMax * 0.36))
                        : ((frameAverage * 0.55) + (frameMax * 0.45));

                    if(frameCount === 0)
                        {
                            window.smoothMax = frameEnergy;
                            smoothVolume = 0;
                            renderFrame.barLevels.fill(0);
                        }
                    else
                        {
                            const smoothHold = isDesktopProfile ? 0.62 : 0.66;
                            window.smoothMax = (window.smoothMax * smoothHold) + (frameEnergy * (1 - smoothHold));
                        }

                    if(frameCount < 30)
                        {
                            if(frameCount >= 5)
                                {
                                    calibrationValues.push(frameEnergy);
                                }

                            frameCount++;

                            if(frameCount === 30)
                                {
                                    const sortedValues = calibrationValues.slice().sort((a, b) => a - b);
                                    let floorCandidate;
                                    
                                    if(isDesktopProfile)
                                        {
                                            const quietCount = Math.max(5, Math.floor(sortedValues.length * 0.28));
                                            const quietSlice = sortedValues.slice(0, quietCount);

                                            const quietAverage = quietSlice.reduce((sum, value) => sum + value, 0) / quietSlice.length;
                                            const quietPeak = quietSlice[quietSlice.length - 1];

                                            floorCandidate = (quietAverage * 0.72) + (quietPeak * 0.28);
                                        }
                                        else
                                            {
                                                const floorIndex = Math.floor(sortedValues.length * 0.35);
                                                floorCandidate = sortedValues[floorIndex] || sortedValues[0];
                                            }

                                    const calibratedFloor = isDesktopProfile ? floorCandidate + 3 : floorCandidate;
                                    
                                    dynamicNoiseFloor = Math.max
                                    (
                                        isDesktopProfile ? 34 : 30,
                                        Math.min(isDesktopProfile ? 165 : 165, calibratedFloor)
                                    );
                                }
                        }
                        else
                            {
                                const floorWindow = isDesktopProfile ? 40 : 32; 
                                if(frameEnergy < dynamicNoiseFloor + floorWindow)
                                    {
                                        const floorHold = isDesktopProfile && renderFrame.desktopCalibrationArmed
                                        ? 0.982
                                        : (isDesktopProfile ? 0.988 : 0.992);

                                        dynamicNoiseFloor = (dynamicNoiseFloor * floorHold) + (frameEnergy * (1 - floorHold));
                                        dynamicNoiseFloor = Math.max
                                        (
                                            isDesktopProfile ? 34 : 30,
                                            Math.min(isDesktopProfile ? 165 : 165, dynamicNoiseFloor)
                                        );
                                    }
                            }
                            
                            if(isDesktopProfile && frameCount < 30)
                                {
                                    smoothVolume = 0;
                                    window.smoothMax = 0;

                                    if(renderFrame.barLevels)
                                        {
                                            renderFrame.barLevels.fill(0);
                                        }

                                    cachedSpans.forEach(span =>
                                        {
                                            span.style.height = '4px';
                                            span.style.opacity = '0.5';
                                        });

                                    if(btn)
                                        {
                                            btn.style.transform = 'scale(1)';
                                        }

                                    animationId = requestAnimationFrame(renderFrame);
                                    return;
                                }
                                
                            if(isDesktopProfile && frameCount === 30 && !renderFrame.desktopCalibrationArmed)
                                {
                                    renderFrame.desktopCalibrationArmed = true;
                                    renderFrame.desktopWakeUpDone = true;

                                    smoothVolume = 0;
                                    window.smoothMax = dynamicNoiseFloor;

                                    if(renderFrame.barLevels)
                                        {
                                            renderFrame.barLevels.fill(0);
                                        }

                                    cachedSpans.forEach(span => 
                                        {
                                            span.style.height = '4px';
                                            span.style.opacity = '0.5';
                                        });

                                    if(btn)
                                        {
                                            btn.style.transform = 'scale(1)';
                                        }

                                    animationId = requestAnimationFrame(renderFrame);
                                    return;
                                }
                            
                            const activeNoiseFloor = frameCount < 30 ? Math.max
                            (
                                isDesktopProfile ? 34 : 30, Math.min
                                (
                                    isDesktopProfile ? 145 : 140, frameEnergy * (isDesktopProfile ? 0.66 : 0.62)
                                )
                            )
                            : dynamicNoiseFloor;
                            
                            const headroom = Math.max(1, 255 - activeNoiseFloor);
                            let responseEnergy = window.smoothMax;

                            if(isDesktopProfile && renderFrame.desktopCalibrationArmed)
                                {
                                    responseEnergy = Math.max
                                    (
                                        window.smoothMax,
                                        (frameEnergy * 0.52) + (window.smoothMax * 0.48)
                                    );
                                }

                            const adjustedValue = Math.max(0, responseEnergy - activeNoiseFloor);

                            let normalized = adjustedValue / headroom;
                            normalized = Math.max(0, Math.min(1, normalized));
                            const gate = isDesktopProfile ? 0.056 : 0.045;
                                
                            let targetAmplitude = 0;
                            let hasGlobalVoice = normalized > gate;
                            let effectiveGate = gate;

                            if(isDesktopProfile)
                                {
                                    const voiceOpenGate = gate * 0.65;
                                    const voiceCloseGate = gate * 0.33;
                                    
                                    if(normalized > voiceOpenGate)
                                        {
                                            renderFrame.voiceCandidateFrames = (renderFrame.voiceCandidateFrames || 0) + 1;
                                        }
                                        else
                                            {
                                                renderFrame.voiceCandidateFrames = 0;
                                            }
                                    
                                    if((renderFrame.voiceCandidateFrames || 0) >= 2)
                                        {
                                            renderFrame.voiceOpen = true;
                                        }
                                        
                                    if(normalized < voiceCloseGate)
                                        {
                                            renderFrame.voiceReleaseFrames = (renderFrame.voiceReleaseFrames || 0) + 1;
                                        }
                                        else
                                            {
                                                renderFrame.voiceReleaseFrames = 0;
                                            }
                                    
                                    if((renderFrame.voiceReleaseFrames || 0) >= 10)
                                        {
                                            renderFrame.voiceOpen = false;
                                        }
                                        
                                    hasGlobalVoice = !!renderFrame.voiceOpen;
                                    effectiveGate = voiceOpenGate;
                                }
                                
                            if(hasGlobalVoice)
                                {
                                    targetAmplitude = Math.max(0, (normalized - effectiveGate) / (1 - effectiveGate));
                                    targetAmplitude = Math.pow(targetAmplitude, isDesktopProfile ? 0.54 : 0.62);
                                }
                            
                            const volumeSmoothing = 
                            targetAmplitude > smoothVolume
                            ? (isDesktopProfile ? 0.35 : 0.48)
                            : (isDesktopProfile ? 0.22 : 0.20);

                            smoothVolume += (targetAmplitude - smoothVolume) * volumeSmoothing;
                            smoothVolume = Math.max(0, Math.min(1, smoothVolume));
                            
                            const usableBinCount = Math.min(binCount, barCount * 10);
                            const firstUsableBin = 0;
                            const effectiveBinSpan = Math.max(barCount, usableBinCount - firstUsableBin);
                            const fixedProfile = [0.72, 0.96, 1.16, 0.96, 0.72];

                            cachedSpans.forEach((span, index) => 
                                {
                                    const start = firstUsableBin + Math.floor((index / barCount) * effectiveBinSpan);
                                    const end = Math.max
                                    (
                                        start + 1,
                                        firstUsableBin + Math.floor(((index + 1) / barCount) * effectiveBinSpan)
                                    );

                                    let bucketSum = 0;
                                    let bucketMax = 0;
                                    let bucketSamples = 0;

                                    for(let i = start; i < end && i < binCount; i++)
                                        {
                                            const value = dataArray[i];
                                            bucketSum += value;
                                            if(value > bucketMax) bucketMax = value;
                                            bucketSamples++;
                                        }

                                        const bucketAverage = bucketSum / Math.max(1, bucketSamples);
                                        const bucketEnergy = isDesktopProfile
                                        ? ((bucketAverage * 0.58) + (bucketMax * 0.42))
                                        : ((bucketAverage * 0.52) + (bucketMax * 0.48));

                                        const desktopLocalFloorFactor = hasGlobalVoice ? 0.88 : 1.00;
                                        const desktopLocalGateFactor = hasGlobalVoice ? 0.68 : 1.00;

                                        let localNormalized = Math.max
                                        (
                                            0,
                                            bucketEnergy - (activeNoiseFloor * (isDesktopProfile ? desktopLocalFloorFactor : 0.68))
                                        ) / headroom;

                                        localNormalized = Math.max(0, Math.min(1, localNormalized));

                                        let localAmplitude = 0;
                                        const localGate = isDesktopProfile ? (gate * desktopLocalGateFactor) : (gate * 0.75);
                                        
                                        if(localNormalized > localGate)
                                            {
                                                localAmplitude = (localNormalized - localGate) / (1 - localGate);
                                                localAmplitude = Math.pow(localAmplitude, isDesktopProfile ? 0.72 : 0.70);
                                            }

                                            const center = (barCount - 1) / 2;
                                            const distance = center > 0 ? Math.abs(index - center) / center : 0;
                                            const adaptiveProfile = 1.14 - (distance * 0.32);
                                            const profile = barCount === 5 ? fixedProfile[index] : adaptiveProfile;
                                            const frequencyBoost = 1 + (index / barCount) * 1.2;

                                            let targetBarLevel = isDesktopProfile
                                            ? (((localAmplitude * 0.56) + (smoothVolume * 0.44)) * profile * frequencyBoost)
                                            : (((localAmplitude * 0.58) + (smoothVolume * 0.42)) * profile);

                                            targetBarLevel = Math.max
                                            (
                                                smoothVolume * (isDesktopProfile ? 0.24 : 0.26),
                                                targetBarLevel
                                            );

                                            targetBarLevel = Math.max(0, Math.min(1, targetBarLevel));

                                            const previousBarLevel = renderFrame.barLevels[index] || 0;

                                            const barSmoothing = targetBarLevel > previousBarLevel
                                            ? (isDesktopProfile ? 0.58 : 0.58)
                                            : (isDesktopProfile ? 0.26 : 0.24);

                                            const barLevel = previousBarLevel + ((targetBarLevel - previousBarLevel) * barSmoothing);

                                            renderFrame.barLevels[index] = Math.max(0, Math.min(1, barLevel));

                                            const height = 4 + (renderFrame.barLevels[index] * 58);
                                            span.style.height = `${height}px`;
                                            span.style.opacity = 0.45 + (renderFrame.barLevels[index] * 0.55);
                                });
                                
                                if(btn)
                                    {
                                        let scale = 1 + (smoothVolume * (isDesktopProfile ? 0.75 : 0.28));
                                        scale = Math.min(scale, isDesktopProfile ? 1.30 : 1.28);
                                        btn.style.transform = `scale(${scale})`;
                                    }
                }
                else
                    {
                        if(cachedSpans)
                            {
                                cachedSpans.forEach(span => 
                                    {
                                        span.style.height = '4px';
                                        span.style.opacity = '0.5';
                                    });
                            }
                            smoothVolume = 0;
                            window.smoothMax = 0;

                            if(renderFrame.barLevels)
                                {
                                    renderFrame.barLevels.fill(0);
                                }

                            if(btn) btn.style.transform = 'scale(1)';
                    }
                    animationId = requestAnimationFrame(renderFrame);
        }

        // ============================================================
        const unlockSpeech = async () =>
        {
            const AudioContextClass = getAudioContextClass();

            if(IS_FIREFOX_DESKTOP)
                {
                    getCueAudioContext();
                }
            else if(!audioCtx && AudioContextClass)
                {
                    audioCtx = getCueAudioContext() || new AudioContextClass();
                }

            const resumed = await resumeAudioContexts();

            speechPrimed = true;

            return resumed;
        };
        
        // ============================================================
        function speak(text, onDone)
        {
            if(!('speechSynthesis' in window))
                {
                    if(typeof onDone === 'function') onDone();
                    return;
                }
                speechSynthesis.cancel();

            if(!selectedVoice)
                {
                    loadVoices();
                }
            
            const utterance = new SpeechSynthesisUtterance(text);

            if(selectedVoice)
                {
                    utterance.voice = selectedVoice;
                    utterance.lang = selectedVoice.lang;
                }
            
            let doneCalled = false;
            let speechStarted = false;

            const safeOnDone = () => 
                {
                    if(doneCalled) return;
                    doneCalled = true;
                    if(typeof onDone === 'function') onDone();
                };
            
            const timeoutId = setTimeout(() => 
                {
                    if(!doneCalled) safeOnDone();
                }, 5000);
            
            utterance.onstart = () => 
                {
                    speechStarted = true;
                };

            utterance.onend = () => 
                {
                    clearTimeout(timeoutId);
                    
                    if(!IS_MOBILE_LIKE_DEVICE)
                        {
                            const waitForRealEnd = () => 
                                {
                                    if(speechSynthesis.speaking)
                                        {
                                            setTimeout(waitForRealEnd, 100);
                                        }
                                        else
                                            {
                                                setTimeout(safeOnDone, 200);
                                            }
                                };
                                waitForRealEnd();
                        }
                        else
                            {
                                safeOnDone();
                            }
                };

                utterance.onerror = () => 
                    {
                        clearTimeout(timeoutId);
                        safeOnDone();
                    };
                    speechSynthesis.speak(utterance);
        }
        
        // ============================================================
        window.addEventListener('load', async () => 
            {
                networkHandler();
                document.body.addEventListener('touchstart', () => {}, {passive: true});
                const loader = document.getElementById('app-loader'); 
                if(loader)
                    {
                        loader.style.opacity = '0'; 
                        loader.style.pointerEvents = 'none'; 

                        setTimeout(() => loader.remove(), 500); 
                    }
                prepareAudioCues();
                warmAudioCueBuffers();
            });
    }
)();