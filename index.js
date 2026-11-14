import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "handy-ai-motion";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const LOG_PREFIX = "[Handy AI Motion]";

const defaultSettings = {
    intifaceAddress: "ws://localhost:12345",
    enabled: true,
    autoConnect: true,
    minSpeed: 32,        // mm/s - TheHandy minimum
    maxSpeed: 450,       // mm/s - TheHandy maximum (use 800 for overclocked)
    strokeLength: 125,   // mm - TheHandy 2 stroke length
    expandSlowMovements: true, // Break slow movements into step-and-hold segments
    stepSize: 1,         // Position % per step when expanding slow movements
    testMessage: "She slowly moved closer, her breath warm against his skin. Her fingers traced gentle patterns down his chest as she pressed her body against his, a soft moan escaping her lips.",
    retryOnInvalid: true,
    maxRetries: 3,
    usePatternsFile: false, // Use predefined patterns from patterns.json
    glideMode: true,         // [glide mod] Blend smoothly between motion settings instead of switching
    fastParse: true,         // [glide mod] Read "Pace N" from the reply's last line without an LLM call
    stopWords: "stop,pause", // [glide mod] Words in the user's message that halt the device at once
    variation: 0.8,          // [glide mod] 0-1: how much natural variation is added when the rhythm is not "even"
    buildIntervalSec: 20,    // [glide mod] seconds per pace level while "building" or "easing"
    edgeCooldownSec: 8,      // [glide mod] shortest time the device stays still after "edge"
    edgeCooldownMaxSec: 15,  // [glide mod] longest time; the actual hold is picked at random in between
    edgeWords: "edge",       // [glide mod] in a short message: full stop and hold
    closeWords: "i'm close,im close,i am close,so close,too close,getting close,about to cum,gonna cum,going to cum", // [glide mod] instant drop to pace 1
    sessionNote: true,       // [glide mod] tell the character the real pace and edge count each turn
    autoFollowUp: true,      // [glide mod] the character speaks again by himself when you stay quiet during a session
    followUpSec: 40,         // [glide mod] roughly how long he waits before speaking again
    followUpMax: 8,          // [glide mod] unprompted replies in a row before he winds down and waits for you
    simulateDevice: false,   // [glide mod] testing only: run the engine with no device connected
    analysisPrompt: `AI MESSAGE:
"""
{{message}}
"""


You are a motion analysis AI. Your task is to analyze the following AI-generated message and extract movement instructions for a linear actuator device (TheHandy), focusing solely on the male character's penile sensations.

Step 1 — Scene Classification

Classify the scene into ONE stimulation state:

- NONE: No sexual stimulation occurring.
- IMPLIED: Sexual tension or anticipation, but no active stimulation.
- ACTIVE: Explicit physical sexual stimulation occurring.
- INTENSE: Explicit stimulation with high intensity or climax-level energy.

Then determine:

- Intensity progression (static / building / peaking / fluctuating)
- Rhythm style (teasing hold / slow stroke / steady stroke / grinding / pulsing / mixed)
- Stroke range width (small 10–20% / medium 30–50% / large 70–100%)
- Dominant depth zone (shallow 10–30% / mid 40–60% / deep 70–90% / full range)
- Complexity level (low / moderate / high)

Complexity guidance:
- low: 2–4 movements in loop
- moderate: 4–8 movements in loop
- high: 8–20 movements allowed if justified by scene

Step 2 — Motion Generation Rules

CRITICAL BEHAVIOR RULES:

If state = NONE:
- Output empty arrays OR a single hold position.
- No rhythmic loop.

If state = IMPLIED:
- Use slow holds or subtle pulsing only.
- Avoid full-range strokes.
- Loop must be minimal and gentle.

If state = ACTIVE:
- Generate rhythmic motion reflecting described stimulation.

If state = INTENSE:
- Increase tempo and/or depth variation appropriately.

Technical Rules:
- delayMs = duration of movement toward the target position.
- If position does not change, this represents a hold.
- Movements must be physically plausible.
- Maintain internal rhythm coherence.
- Avoid unnecessary mechanical repetition unless the scene implies it.
- If nothing happens, it is acceptable and needed to output:
  { "start": [], "loop": [] }

Output format:

Brief explanation (1–2 sentences)

Motion Profile:
- Stimulation state: ...
- Intensity progression: ...
- Rhythm style: ...
- Stroke range width: ...
- Dominant depth zone: ...
- Complexity level: ...

Then JSON in a code block EXACTLY as:

{
  "start": [
    "delayMs,posPercent"
  ],
  "loop": [
    "delayMs,posPercent"
  ]
}

You can add comments to the lines if needed

Numeric Constraints:
- delayMs must be a positive integer (> 0).
- posPercent must be an integer from 0 to 100 inclusive.
- Never output negative numbers.
- Never output decimals.


ANALYSIS START (optional 1-2 sentences and detailed mandatory JSON with start and loop):
`,
    patternsPrompt: `AI MESSAGE:
"""
{{message}}
"""

AVAILABLE PATTERNS:
{{pattern_data}}

You are a motion pattern selector AI. Your task is to analyze the AI-generated message and select the most appropriate pattern from the available patterns above, then customize it with speed and range modifiers.

Step 1 — Scene Classification

Classify the scene into ONE stimulation state:
- NONE: No sexual stimulation occurring.
- IMPLIED: Sexual tension or anticipation, but no active stimulation.
- ACTIVE: Explicit physical sexual stimulation occurring.
- INTENSE: Explicit stimulation with high intensity or climax-level energy.

Step 2 — Pattern Selection Rules

If state = NONE:
- Select any gentle pattern with speed_percent: 20 or lower.
- Range modifiers should keep movements minimal.

If state = IMPLIED:
- Select patterns like "sine", "pulse", or "slow_tease".
- Use speed_percent between 20-50.

If state = ACTIVE:
- Select patterns that match the described rhythm.
- Use speed_percent between 50-80.

If state = INTENSE:
- Select patterns like "fast_stroke", "depth_thrust", or "wave_build".
- Use speed_percent between 80-100.

Range Modifiers:
- range_min: New minimum position (0-100, default from pattern)
- range_max: New maximum position (0-100, default from pattern)
- Use these to shift or compress the pattern's range.

Output format:

Brief explanation (1–2 sentences)

Then JSON in a code block EXACTLY as:

{
  "pattern": "pattern_name",
  "speed_percent": 50,
  "range_min": 0,
  "range_max": 100
}

Where:
- pattern: The exact name of the selected pattern from the available patterns
- speed_percent: Speed modifier from 0-100 (0 = very slow, 100 = maximum speed)
- range_min: Minimum position boundary (optional, uses pattern default if omitted)
- range_max: Maximum position boundary (optional, uses pattern default if omitted)


ANALYSIS START:
`,
    debugMode: false,
};

// Default duration when LLM returns 0 or missing delay (in ms)
const DEFAULT_MOVEMENT_DURATION = 250;

// State objects - initialized before any function calls
const IntifaceState = {
    SERVER_ADDRESS: "ws://localhost:12345",
    socket: null,
    messageId: 1,
    reconnectTimer: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    defaultDeviceIndex: null,
    deviceCapabilities: {
        canLinear: false,
        canStopDevice: false,
    },
};

const PlaybackState = {
    isPlaying: false,
    startQueue: [],
    loopQueue: [],
    currentTimeout: null,
    currentPhase: null,
    loopIndex: 0,
    abortController: null,
    currentPosition: 0,  // Track position across movements (0-100%)
};

// Cache for loaded patterns
let cachedPatterns = null;

/* ================================================================================================
   CONFIG ACCESSOR
================================================================================================ */
/**
 * Retrieves the configuration settings for the extension.
 * Merges default settings with user-defined settings.
 * @returns {Object} The configuration object.
 */
function getConfig() {
    const s = extension_settings?.[extensionName];
    return s ? { ...defaultSettings, ...s } : { ...defaultSettings };
}

/* ================================================================================================
   PATTERNS FILE HANDLING
================================================================================================ */
/**
 * Loads patterns from the patterns.json file.
 * @returns {Promise<Array>} Array of pattern objects.
 */
async function loadPatterns() {
    if (cachedPatterns) {
        return cachedPatterns;
    }
    
    try {
        const response = await fetch(`${extensionFolderPath}/patterns.json`);
        if (!response.ok) {
            console.warn(`${LOG_PREFIX} Could not load patterns.json: ${response.status}`);
            return [];
        }
        
        const data = await response.json();
        cachedPatterns = data.patterns || [];
        
        if (cachedPatterns.length > 0) {
            console.log(`${LOG_PREFIX} Loaded ${cachedPatterns.length} patterns from patterns.json`);
        }
        
        return cachedPatterns;
    } catch (err) {
        console.warn(`${LOG_PREFIX} Error loading patterns.json:`, err);
        return [];
    }
}

/**
 * Generates pattern data string for LLM prompt.
 * @param {Array} patterns - Array of pattern objects.
 * @returns {string} Formatted pattern data for LLM.
 */
function generatePatternDataForLLM(patterns) {
    if (!patterns || patterns.length === 0) {
        return "No patterns available.";
    }
    
    const patternLines = patterns.map(p => {
        return `- "${p.name}": ${p.description}`;
    });
    
    return patternLines.join('\n');
}

/**
 * Finds a pattern by name.
 * @param {string} name - The pattern name to find.
 * @param {Array} patterns - Array of pattern objects.
 * @returns {Object|null} The found pattern or null.
 */
function findPatternByName(name, patterns) {
    return patterns.find(p => p.name === name) || null;
}

/**
 * Applies speed and range modifiers to a pattern.
 * @param {Object} pattern - The pattern object with start and loop arrays.
 * @param {number} speedPercent - Speed modifier (0-100, where 100 = original speed).
 * @param {number} rangeMin - Minimum position boundary (optional).
 * @param {number} rangeMax - Maximum position boundary (optional).
 * @returns {Object} Modified pattern with adjusted timing and positions.
 */
function applyPatternModifiers(pattern, speedPercent, rangeMin = null, rangeMax = null) {
    const speedMultiplier = Math.max(0.1, speedPercent / 100);
    
    // Determine original range from pattern
    const allPositions = [...(pattern.pattern.start || []), ...(pattern.pattern.loop || [])]
        .map(s => {
            const parts = s.split(',');
            return parseInt(parts[1]) || 0;
        });
    
    const originalMin = Math.min(...allPositions);
    const originalMax = Math.max(...allPositions);
    const originalRange = originalMax - originalMin;
    
    // Use provided range or keep original
    const newMin = rangeMin !== null ? rangeMin : originalMin;
    const newMax = rangeMax !== null ? rangeMax : originalMax;
    const newRange = newMax - newMin;
    
    /**
     * Modifies a movement string with speed and range adjustments.
     * @param {string} movementStr - The movement string "delayMs,posPercent".
     * @returns {string} Modified movement string.
     */
    const modifyMovement = (movementStr) => {
        const parts = movementStr.split(',');
        if (parts.length !== 2) return movementStr;
        
        const delay = parseInt(parts[0]);
        let pos = parseFloat(parts[1]);
        
        if (isNaN(delay) || isNaN(pos)) return movementStr;
        
        // Apply speed modifier (inverse: lower speed = longer delay)
        const newDelay = Math.round(delay / speedMultiplier);
        
        // Apply range modifier
        if (originalRange > 0) {
            // Normalize position to 0-1 within original range
            const normalizedPos = (pos - originalMin) / originalRange;
            // Map to new range
            pos = Math.round(newMin + (normalizedPos * newRange));
        }
        
        // Clamp position to valid range
        pos = Math.max(0, Math.min(100, pos));
        
        return `${newDelay},${pos}`;
    };
    
    return {
        start: (pattern.pattern.start || []).map(modifyMovement),
        loop: (pattern.pattern.loop || []).map(modifyMovement)
    };
}

/**
 * Parses LLM response for pattern selection.
 * @param {string} response - The LLM response text.
 * @param {boolean} debugMode - Whether to log debug info.
 * @returns {Object|null} Parsed pattern selection or null.
 */
function parsePatternSelection(response, debugMode = false) {
    if (!response || typeof response !== 'string') {
        return null;
    }
    
    // Try to extract JSON from the response
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let jsonStr = null;
    
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    } else {
        // Try to find a JSON object directly
        const directJsonMatch = response.match(/\{[\s\S]*?"pattern"[\s\S]*?\}/i);
        if (directJsonMatch) {
            jsonStr = directJsonMatch[0];
        }
    }
    
    if (!jsonStr) {
        if (debugMode) {
            console.log(`${LOG_PREFIX} No JSON found in pattern selection response`);
        }
        return null;
    }
    
    try {
        const parsed = JSON.parse(jsonStr);
        
        if (!parsed.pattern || typeof parsed.pattern !== 'string') {
            return null;
        }
        
        return {
            pattern: parsed.pattern,
            speed_percent: parsed.speed_percent !== undefined ? parsed.speed_percent : 50,
            range_min: parsed.range_min !== undefined ? parsed.range_min : null,
            range_max: parsed.range_max !== undefined ? parsed.range_max : null
        };
    } catch (err) {
        if (debugMode) {
            console.log(`${LOG_PREFIX} Failed to parse pattern selection JSON:`, err);
        }
        return null;
    }
}

/* ================================================================================================
   STATUS UI HELPERS
================================================================================================ */
/**
 * Updates the Intiface connection status in the UI.
 * @param {boolean} isConnected - Whether the Intiface server is connected.
 */
function updateIntifaceStatus(isConnected) {
    const el = document.getElementById("ham_intiface_status");
    if (!el) return;

    if (isConnected) {
        el.textContent = "Connected";
        el.classList.remove("error");
        el.classList.add("ready");
    } else {
        el.textContent = "Not Connected";
        el.classList.remove("ready");
        el.classList.add("error");
    }
}

/**
 * Updates the device connection status in the UI.
 * @param {boolean} hasDevice - Whether a compatible device is connected.
 */
function updateDeviceStatus(hasDevice) {
    const el = document.getElementById("ham_device_status");
    if (!el) return;

    if (hasDevice) {
        el.textContent = "TheHandy Ready";
        el.classList.remove("error");
        el.classList.add("ready");
    } else {
        el.textContent = "No Device";
        el.classList.remove("ready");
        el.classList.add("error");
    }
}

/**
 * Updates the playback status in the UI.
 * @param {boolean} isPlaying - Whether playback is currently active.
 */
function updatePlaybackStatus(isPlaying) {
    const el = document.getElementById("ham_playback_status");
    if (!el) return;

    if (isPlaying) {
        el.textContent = "Playing";
        el.classList.remove("idle");
        el.classList.add("playing");
    } else {
        el.textContent = "Idle";
        el.classList.remove("playing");
        el.classList.add("idle");
    }
}

/* ================================================================================================
   [glide mod] MOVE TRACKER - estimates where the device is between commands
================================================================================================ */
const MoveTracker = {
    from: 0,
    to: 0,
    t0: 0,
    dur: 0,
    estimate() {
        if (!this.dur) return this.to;
        const f = Math.max(0, Math.min(1, (Date.now() - this.t0) / this.dur));
        return this.from + (this.to - this.from) * f;
    },
    record(position, duration) {
        const now = this.estimate();
        this.from = now;
        this.to = Math.max(0, Math.min(100, Number(position) || 0));
        this.t0 = Date.now();
        this.dur = Math.max(0, duration);
    },
};

/* ================================================================================================
   DEVICE COMMANDS
================================================================================================ */
const DeviceCommands = {
    /**
     * Clamps a position value to the range 0-100%.
     * @param {number} pos - The position value to clamp.
     * @returns {number} The clamped position value.
     */
    clampPosition(pos) {
        return Math.max(0, Math.min(1, pos / 100));
    },

    /**
     * Sends a linear movement command to the connected device.
     * @param {number} position - Target position (0-100%).
     * @param {number} durationMs - Duration of the movement in milliseconds.
     * @returns {boolean} Whether the command was successfully sent.
     */
    linear(position, durationMs) {
        if (IntifaceState.defaultDeviceIndex === null) {
            if (getConfig().simulateDevice) {
                // [glide mod] testing only: pretend the move happened
                MoveTracker.record(position, Math.max(0, durationMs));
                return true;
            }
            console.warn(`${LOG_PREFIX} No device connected`);
            return false;
        }

        if (!IntifaceState.deviceCapabilities.canLinear) {
            console.warn(`${LOG_PREFIX} Device does not support linear commands`);
            return false;
        }

        const pos = this.clampPosition(position);
        const duration = Math.max(0, durationMs);

        // [glide mod] remember this move so the current position can be estimated mid-stroke
        MoveTracker.record(position, duration);

        const settings = getConfig();
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Linear: pos=${pos.toFixed(2)} (${position}%), duration=${duration}ms`);
        }

        return intifaceSend({
            LinearCmd: {
                Id: IntifaceState.messageId++,
                DeviceIndex: IntifaceState.defaultDeviceIndex,
                Vectors: [{
                    Index: 0,
                    Position: pos,
                    Duration: duration,
                }],
            }
        });
    },

    /**
     * Stops all device movements.
     */
    stopAll() {
        if (IntifaceState.defaultDeviceIndex === null) return;

        this.linear(0, 200);

        if (IntifaceState.deviceCapabilities.canStopDevice) {
            intifaceSend({
                StopDeviceCmd: {
                    Id: IntifaceState.messageId++,
                    DeviceIndex: IntifaceState.defaultDeviceIndex,
                }
            });
        }

        console.log(`${LOG_PREFIX} Device stopped`);
    }
};

/* ================================================================================================
   INTIFACE CONNECTION FUNCTIONS
================================================================================================ */
/**
 * Sends a message to the Intiface server via WebSocket.
 * @param {Object} msgObj - The message object to send.
 * @returns {boolean} Whether the message was successfully sent.
 */
function intifaceSend(msgObj) {
    if (!IntifaceState.socket || IntifaceState.socket.readyState !== WebSocket.OPEN) {
        console.warn(`${LOG_PREFIX} Cannot send - not connected`);
        return false;
    }
    
    try {
        IntifaceState.socket.send(JSON.stringify([msgObj]));
        return true;
    } catch (err) {
        console.error(`${LOG_PREFIX} Send failed:`, err);
        return false;
    }
}

/**
 * Handles incoming messages from the Intiface server and updates device state accordingly.
 * @param {Object} msg - The message object received from the Intiface server.
 */
function handleIntifaceMessage(msg) {
    const settings = getConfig();
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Received:`, msg);
    }

    if (msg.ServerInfo) {
        console.log(`${LOG_PREFIX} Server info received:`, msg.ServerInfo);
        intifaceSend({ StartScanning: { Id: IntifaceState.messageId++ } });
        intifaceSend({ RequestDeviceList: { Id: IntifaceState.messageId++ } });
        return;
    }

    if (msg.DeviceList || msg.DeviceAdded) {
        const devices = msg.DeviceList?.Devices || (msg.DeviceAdded ? [msg.DeviceAdded] : []);
        
        for (const d of devices) {
            const rawMsgs = d.DeviceMessages || [];
            let msgNames = [];
            
            if (Array.isArray(rawMsgs)) {
                msgNames = rawMsgs.flatMap(m => {
                    if (typeof m === "string") return [m];
                    if (m && typeof m === "object") return Object.keys(m);
                    return [];
                });
            } else if (rawMsgs && typeof rawMsgs === "object") {
                msgNames = Object.keys(rawMsgs);
            }

            const canLinear = msgNames.some(n => /Linear/i.test(n));
            
            if (canLinear) {
                IntifaceState.defaultDeviceIndex = d.DeviceIndex;
                IntifaceState.deviceCapabilities = {
                    canLinear: true,
                    canStopDevice: msgNames.some(n => /StopDevice/i.test(n)),
                };
                
                console.log(`${LOG_PREFIX} Device found: ${d.DeviceName || 'Unknown'} (Index: ${d.DeviceIndex})`);
                console.log(`${LOG_PREFIX} Capabilities:`, IntifaceState.deviceCapabilities);
                updateDeviceStatus(true);
                
                intifaceSend({ StopScanning: { Id: IntifaceState.messageId++ } });
                return;
            }
        }

        if (msg.DeviceList) {
            console.log(`${LOG_PREFIX} No linear actuator device found in device list`);
            updateDeviceStatus(false);
        }
        return;
    }

    if (msg.DeviceRemoved) {
        if (msg.DeviceRemoved.DeviceIndex === IntifaceState.defaultDeviceIndex) {
            IntifaceState.defaultDeviceIndex = null;
            IntifaceState.deviceCapabilities = { canLinear: false, canStopDevice: false };
            updateDeviceStatus(false);
            stopPlayback();
            console.log(`${LOG_PREFIX} Device removed`);
        }
        return;
    }

    if (msg.ScanningFinished) {
        console.log(`${LOG_PREFIX} Scanning finished`);
        return;
    }

    if (msg.Error) {
        console.error(`${LOG_PREFIX} Intiface Error:`, msg.Error);
    }
}

/**
 * Establishes a WebSocket connection to the Intiface server and sets up event handlers.
 */
function connectIntiface() {
    if (IntifaceState.socket &&
        (IntifaceState.socket.readyState === WebSocket.OPEN ||
            IntifaceState.socket.readyState === WebSocket.CONNECTING)) {
        console.log(`${LOG_PREFIX} Already connected or connecting`);
        return;
    }

    console.log(`${LOG_PREFIX} Connecting to Intiface at ${IntifaceState.SERVER_ADDRESS}...`);
    
    try {
        IntifaceState.socket = new WebSocket(IntifaceState.SERVER_ADDRESS);
    } catch (err) {
        console.error(`${LOG_PREFIX} WebSocket creation failed:`, err);
        updateIntifaceStatus(false);
        return;
    }

    IntifaceState.socket.onopen = () => {
        console.log(`${LOG_PREFIX} WebSocket connected`);
        updateIntifaceStatus(true);
        IntifaceState.reconnectAttempts = 0;
        
        intifaceSend({
            RequestServerInfo: {
                Id: IntifaceState.messageId++,
                ClientName: "SillyTavern Handy AI Motion",
                MessageVersion: 3,
            }
        });
    };

    IntifaceState.socket.onclose = () => {
        updateIntifaceStatus(false);
        updateDeviceStatus(false);
        IntifaceState.defaultDeviceIndex = null;
        console.log(`${LOG_PREFIX} WebSocket closed`);

        const settings = getConfig();
        if (settings.autoConnect && IntifaceState.reconnectAttempts < IntifaceState.maxReconnectAttempts) {
            if (IntifaceState.reconnectTimer) return;
            
            IntifaceState.reconnectAttempts++;
            console.log(`${LOG_PREFIX} Reconnecting in 2s (attempt ${IntifaceState.reconnectAttempts}/${IntifaceState.maxReconnectAttempts})`);
            
            IntifaceState.reconnectTimer = setTimeout(() => {
                IntifaceState.reconnectTimer = null;
                connectIntiface();
            }, 2000);
        }
    };

    IntifaceState.socket.onerror = (err) => {
        updateIntifaceStatus(false);
        console.error(`${LOG_PREFIX} WebSocket error:`, err);
    };

    IntifaceState.socket.onmessage = (evt) => {
        let messages;
        try {
            messages = JSON.parse(evt.data);
        } catch {
            console.warn(`${LOG_PREFIX} Failed to parse message:`, evt.data);
            return;
        }
        
        if (!Array.isArray(messages)) {
            messages = [messages];
        }
        
        messages.forEach((m) => handleIntifaceMessage(m));
    };
}

/**
 * Disconnects from the Intiface server, clears reconnect attempts, and resets device state.
 */
function disconnectIntiface() {
    if (IntifaceState.reconnectTimer) {
        clearTimeout(IntifaceState.reconnectTimer);
        IntifaceState.reconnectTimer = null;
    }
    IntifaceState.reconnectAttempts = IntifaceState.maxReconnectAttempts;
    
    if (IntifaceState.socket) {
        IntifaceState.socket.close();
        IntifaceState.socket = null;
    }
    
    stopPlayback();
    updateIntifaceStatus(false);
    updateDeviceStatus(false);
    IntifaceState.defaultDeviceIndex = null;
    console.log(`${LOG_PREFIX} Disconnected`);
}

/* ================================================================================================
   PLAYBACK ENGINE
================================================================================================ */
/**
 * Executes the next movement in the playback queue.
 * Handles both the start and loop phases of the playback.
 * If no movements are left, stops the playback.
 */
function executeNextMovement() {
    if (!PlaybackState.isPlaying || PlaybackState.abortController?.aborted) {
        return;
    }

    let movement = null;

    if (PlaybackState.currentPhase === 'start' && PlaybackState.startQueue.length > 0) {
        movement = PlaybackState.startQueue.shift();
    } else if (PlaybackState.loopQueue.length > 0) {
        PlaybackState.currentPhase = 'loop';
        movement = PlaybackState.loopQueue[PlaybackState.loopIndex];
        PlaybackState.loopIndex = (PlaybackState.loopIndex + 1) % PlaybackState.loopQueue.length;
    }

    if (!movement) {
        stopPlayback();
        return;
    }

    const { delay, pos } = movement;
    const settings = getConfig();
    
    // Get the requested duration, use default if delay is 0 or missing
    let duration = delay > 0 ? delay : DEFAULT_MOVEMENT_DURATION;
    
    // Calculate speed and clamp if necessary
    const currentPos = PlaybackState.currentPosition;
    const positionDelta = Math.abs(pos - currentPos);
    
    // Only apply speed clamping if there's actual movement
    if (positionDelta > 0) {
        const strokeLength = settings.strokeLength || 125;
        const minSpeed = settings.minSpeed || 32;
        const maxSpeed = settings.maxSpeed || 450;
        
        // Calculate distance in mm
        const distanceMm = (positionDelta / 100) * strokeLength;
        
        // Calculate requested speed in mm/s
        const requestedSpeed = distanceMm / (duration / 1000);
        
        // Clamp speed to min/max range
        let actualSpeed = requestedSpeed;
        if (requestedSpeed > maxSpeed) {
            actualSpeed = maxSpeed;
        } else if (requestedSpeed < minSpeed) {
            actualSpeed = minSpeed;
        }
        
        // Recalculate duration based on clamped speed
        if (actualSpeed !== requestedSpeed) {
            duration = Math.round((distanceMm / actualSpeed) * 1000);
        }
    }
    
    // Update current position
    PlaybackState.currentPosition = pos;

    // Execute the linear command
    DeviceCommands.linear(pos, duration);

    // Wait for the movement to complete before executing the next movement
    PlaybackState.currentTimeout = setTimeout(() => {
        if (PlaybackState.abortController?.aborted) return;
        executeNextMovement();
    }, duration);
}

/**
 * Parses a movement string in the format "delay,pos" into an object.
 * @param {string} str - The movement string to parse.
 * @returns {{delay: number, pos: number} | null} The parsed movement object or null if invalid.
 */
function parseMovementString(str) {
    const parts = str.split(",");
    if (parts.length !== 2) return null;
    
    const delay = parseInt(parts[0]);
    const pos = parseFloat(parts[1]);
    
    if (isNaN(delay) || isNaN(pos)) return null;
    
    return { delay, pos };
}

/**
 * Parses movement data containing 'start' and 'loop' arrays of movement strings.
 * @param {Object} data - The movement data object.
 * @returns {{start: Array, loop: Array}} Parsed movement arrays.
 */
function parseMovementData(data) {
    const start = [];
    const loop = [];

    if (data.start && Array.isArray(data.start)) {
        for (const s of data.start) {
            const parsed = parseMovementString(s);
            if (parsed) start.push(parsed);
        }
    }

    if (data.loop && Array.isArray(data.loop)) {
        for (const s of data.loop) {
            const parsed = parseMovementString(s);
            if (parsed) loop.push(parsed);
        }
    }

    return { start, loop };
}

/**
 * Starts the playback of the movement data.
 * Parses and optionally expands the movement data, then begins execution.
 * @param {Object} data - The movement data containing start and loop arrays.
 */
function startPlayback(data) {
    const settings = getConfig();
    
    stopPlayback();

    let { start, loop } = parseMovementData(data);

    if (start.length === 0 && loop.length === 0) {
        console.warn(`${LOG_PREFIX} No valid movement data`);
        return;
    }

    // Expand slow movements if enabled
    if (settings.expandSlowMovements) {
        // For start expansion, use the starting position of the loop phase
        // This ensures the first loop movement is expanded correctly
        const firstLoopPos = loop.length > 0 ? loop[0].pos : PlaybackState.currentPosition;
        start = expandMovements(start, settings, "start", firstLoopPos);
        
        // For loop expansion, use the last position of the loop phase
        // This ensures the last loop movement connects properly with the first loop movement, creating a seamless cycle
        const lastLoopPos = loop.length > 0 ? loop[loop.length - 1].pos : PlaybackState.currentPosition;
        loop = expandMovements(loop, settings, "loop", lastLoopPos);
    }

    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Parsed movements - Start:`, start, "Loop:", loop);
    }

    PlaybackState.startQueue = [...start];
    PlaybackState.loopQueue = [...loop];
    PlaybackState.isPlaying = true;
    PlaybackState.currentPhase = 'start';
    PlaybackState.loopIndex = 0;
    PlaybackState.abortController = { aborted: false };

    updatePlaybackStatus(true);

    executeNextMovement();
}

/**
 * Stops the current playback and resets the playback state.
 * Clears any active timeouts and aborts the playback controller.
 */
function stopPlayback() {
    Glide.halt(); // [glide mod]
    if (PlaybackState.currentTimeout) {
        clearTimeout(PlaybackState.currentTimeout);
        PlaybackState.currentTimeout = null;
    }

    if (PlaybackState.abortController) {
        PlaybackState.abortController.aborted = true;
        PlaybackState.abortController = null;
    }

    PlaybackState.isPlaying = false;
    PlaybackState.startQueue = [];
    PlaybackState.loopQueue = [];
    PlaybackState.currentPhase = null;
    PlaybackState.loopIndex = 0;

    updatePlaybackStatus(false);
    
    console.log(`${LOG_PREFIX} Playback stopped`);
}

/* ================================================================================================
   [glide mod] GLIDE ENGINE
   Keeps the device stroking between two positions at a "pace" (1-10) and moves gradually toward
   new settings a little on every stroke, so changes are never abrupt.
================================================================================================ */
const GLIDE_PACE_STEP = 0.5;   // max pace change per half-stroke
const GLIDE_RANGE_STEP = 6;    // max change of either end position (%) per half-stroke
const GLIDE_MIN_SPAN = 8;      // smallest allowed stroke span (%)
const GLIDE_PACE1_SPEED = 36;  // mm/s at pace 1
const GLIDE_PACE10_SPEED = 340;// mm/s at pace 10

// Edge tracking for the current chat
const Session = {
    edgeCount: 0,
    edgeGoal: 0,
    edgePendingAck: false,  // "edge" was called and the character has not replied yet
    closePendingAck: false, // "I'm close" was said and the character has not replied yet
    lastEdgeAt: 0,
    preEdgePace: 0,         // pace before the last edge, so the character can build back toward it
    generating: false,
    followUpReason: null,   // why the character is being asked to speak unprompted: 'idle' | 'final' | 'edge-resume'
    queuedFollowUp: null,
    awaitingFollowUp: false,
    unprompted: 0,          // unprompted replies in a row
    stopRequested: false,   // the user said stop: nothing restarts until they speak again
    idleTimer: null,
    fallbackTimer: null,
};

/** [glide mod] True when a device is connected (or testing without one). */
function deviceAvailable() {
    return IntifaceState.defaultDeviceIndex !== null || !!getConfig().simulateDevice;
}

/** [glide mod] Counts an edge, ignoring a second call within 20 seconds of the last. */
function countEdge() {
    if (Date.now() - Session.lastEdgeAt > 20000) {
        Session.edgeCount++;
    }
    Session.lastEdgeAt = Date.now();
}

const Glide = {
    active: false,
    stopping: false,
    easedOut: false,
    timer: null,
    dir: 1,
    cur: { pace: 0, lo: 10, hi: 90, hold: 0, vary: 1 },
    tgt: { pace: 0, lo: 10, hi: 90, hold: 0, vary: 1 },
    build: null,          // { to, dir, nextAt } while the pace is climbing or easing on its own
    cooldownUntil: 0,     // after an edge, nothing moves until this time
    cooldownTimer: null,
    pending: null,        // target received during an edge cooldown
    jitter: 0,            // slow random drift of stroke speed
    fx: null,             // short-lived variation: { type, left }
    sinceFx: 0,

    paceToSpeed(pace, settings) {
        const p = Math.max(1, Math.min(10, pace));
        const speed = GLIDE_PACE1_SPEED * Math.pow(GLIDE_PACE10_SPEED / GLIDE_PACE1_SPEED, (p - 1) / 9);
        const minSpeed = settings.minSpeed || 32;
        const maxSpeed = settings.maxSpeed || 450;
        return Math.max(minSpeed, Math.min(maxSpeed, speed));
    },

    /** Normalizes a target object {pace, min, max, hold, vary, buildTo}. */
    normalize(t) {
        let pace = Number(t.pace);
        if (!isFinite(pace)) pace = 0;
        pace = Math.max(0, Math.min(10, pace));
        let lo = Number(t.min);
        let hi = Number(t.max);
        if (!isFinite(lo)) lo = 10;
        if (!isFinite(hi)) hi = 90;
        lo = Math.max(0, Math.min(100, lo));
        hi = Math.max(0, Math.min(100, hi));
        if (lo > hi) [lo, hi] = [hi, lo];
        if (hi - lo < GLIDE_MIN_SPAN) {
            const mid = (lo + hi) / 2;
            lo = Math.max(0, mid - GLIDE_MIN_SPAN / 2);
            hi = Math.min(100, lo + GLIDE_MIN_SPAN);
            lo = hi - GLIDE_MIN_SPAN;
        }
        let hold = Number(t.hold);
        if (!isFinite(hold)) hold = 0;
        hold = Math.max(0, Math.min(3000, hold));
        const vary = (t.vary === undefined || t.vary === null) ? 1 : (Number(t.vary) > 0 ? 1 : 0);
        let buildTo = (t.buildTo === undefined || t.buildTo === null) ? null : Number(t.buildTo);
        if (buildTo !== null) {
            buildTo = isFinite(buildTo) ? Math.max(1, Math.min(10, buildTo)) : null;
        }
        return { pace, lo, hi, hold, vary, buildTo };
    },

    /** Sets new settings to glide toward. pace 0 eases down and stops. */
    setTarget(t) {
        if (Date.now() < this.cooldownUntil) {
            // An edge was just called: remember this and apply it when the hold ends
            this.pending = t;
            return;
        }

        const target = this.normalize(t);
        const settings = getConfig();
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Glide target: pace ${target.pace}, ${target.lo}-${target.hi}%, hold ${target.hold}ms, vary ${target.vary}, buildTo ${target.buildTo}`);
        }

        if (target.pace <= 0) {
            this.build = null;
            if (this.active) {
                this.stopping = true;
                this.tgt.pace = 0;
            }
            this.report();
            return;
        }

        this.stopping = false;
        this.easedOut = false;
        this.tgt = { pace: target.pace, lo: target.lo, hi: target.hi, hold: target.hold, vary: target.vary };

        if (target.buildTo !== null && target.buildTo !== target.pace) {
            const interval = Math.max(5, Number(settings.buildIntervalSec) || 20) * 1000;
            this.build = { to: target.buildTo, dir: target.buildTo > target.pace ? 1 : -1, nextAt: Date.now() + interval };
        } else {
            this.build = null;
        }

        if (!this.active) {
            // Stop any classic pattern playback, then start gently from pace 1
            if (PlaybackState.isPlaying) stopPlayback();
            this.cur = { pace: Math.min(1, target.pace), lo: target.lo, hi: target.hi, hold: target.hold, vary: target.vary };
            const pos = MoveTracker.estimate();
            this.dir = Math.abs(pos - target.lo) <= Math.abs(pos - target.hi) ? 1 : -1;
            this.jitter = 0;
            this.fx = null;
            this.sinceFx = 0;
            this.active = true;
            updatePlaybackStatus(true);
            this.tick();
        }
        this.report();
    },

    approach(value, goal, step) {
        if (value < goal) return Math.min(goal, value + step);
        if (value > goal) return Math.max(goal, value - step);
        return value;
    },

    tick() {
        if (!this.active) return;
        const settings = getConfig();

        if (!deviceAvailable()) {
            console.warn(`${LOG_PREFIX} Glide: no device connected, stopping`);
            this.halt();
            updatePlaybackStatus(false);
            this.report();
            return;
        }

        // Self-building pace: raise or lower the target one level at a time
        if (this.build && !this.stopping && Date.now() >= this.build.nextAt) {
            const interval = Math.max(5, Number(settings.buildIntervalSec) || 20) * 1000;
            const next = this.tgt.pace + this.build.dir;
            if ((this.build.dir > 0 && next >= this.build.to) || (this.build.dir < 0 && next <= this.build.to)) {
                this.tgt.pace = this.build.to;
                this.build = null;
            } else {
                this.tgt.pace = next;
                this.build.nextAt = Date.now() + interval;
            }
        }

        // Ease toward the target a little on every half-stroke
        if (this.stopping) {
            // One last stroke at half the pace, then rest where that stroke ends
            if (this.easedOut) {
                this.halt();
                updatePlaybackStatus(false);
                this.report();
                console.log(`${LOG_PREFIX} Glide eased to a stop`);
                return;
            }
            this.easedOut = true;
            this.cur.pace = Math.max(1, this.cur.pace / 2);
        } else {
            this.cur.pace = this.approach(this.cur.pace, this.tgt.pace, GLIDE_PACE_STEP);
            this.cur.lo = this.approach(this.cur.lo, this.tgt.lo, GLIDE_RANGE_STEP);
            this.cur.hi = this.approach(this.cur.hi, this.tgt.hi, GLIDE_RANGE_STEP);
            this.cur.hold = this.tgt.hold;
            this.cur.vary = this.tgt.vary;
        }

        // Natural variation (off for an "even" rhythm and while easing to a stop)
        const amount = (this.stopping || !this.cur.vary) ? 0 : Math.max(0, Math.min(1, Number(settings.variation ?? 0.8)));
        let speedFactor = 1;
        let extraPause = 0;
        let shape = null; // 'short' | 'high' | 'low'
        if (amount > 0) {
            // Slow drift of speed, up to about 20%
            const limit = 0.2 * amount;
            this.jitter = Math.max(-limit, Math.min(limit, this.jitter * 0.75 + (Math.random() - 0.5) * 0.2 * amount));
            speedFactor += this.jitter;

            // Every few strokes something small happens: a brief pause, a couple of slower strokes,
            // a slightly quicker run, a short stroke, or a flutter of short strokes at one end
            this.sinceFx++;
            if (!this.fx && this.sinceFx > 4 && Math.random() < 0.2 * amount) {
                const types = ['pause', 'slow', 'burst', 'short', 'flutter'];
                const type = types[Math.floor(Math.random() * types.length)];
                const extra = Math.floor(Math.random() * 3);
                const left = { pause: 1, slow: 2 + extra, burst: 4 + extra, short: 2, flutter: 6 + 2 * extra }[type];
                this.fx = { type, left, high: Math.random() < 0.6 };
            }
            if (this.fx) {
                if (this.fx.type === 'pause') extraPause = 300 + Math.round(Math.random() * 600);
                else if (this.fx.type === 'slow') speedFactor *= 0.7;
                else if (this.fx.type === 'burst') speedFactor *= 1.2;
                else if (this.fx.type === 'short') shape = 'short';
                else if (this.fx.type === 'flutter') shape = this.fx.high ? 'high' : 'low';
                this.fx.left--;
                if (this.fx.left <= 0) {
                    this.fx = null;
                    this.sinceFx = 0;
                }
            }
        } else {
            this.jitter = 0;
            this.fx = null;
        }

        const pos = MoveTracker.estimate();
        let lo = this.cur.lo;
        let hi = this.cur.hi;
        const span = hi - lo;
        if (shape === 'high' && span > 40) lo = hi - span * 0.35;
        else if (shape === 'low' && span > 40) hi = lo + span * 0.35;

        let dest = this.dir > 0 ? hi : lo;
        if (Math.abs(dest - pos) < 1) {
            this.dir = -this.dir;
            dest = this.dir > 0 ? hi : lo;
        }
        if (amount > 0) {
            // Vary where each stroke ends a little; a "short" stroke turns back near the middle
            if (shape === 'short' && span > 2 * GLIDE_MIN_SPAN) {
                dest = dest + (this.dir > 0 ? -1 : 1) * span * 0.4;
            } else {
                dest += (Math.random() - 0.5) * 2 * Math.min(8, span * 0.12) * amount;
            }
            dest = Math.max(0, Math.min(100, dest));
        }

        const strokeLength = settings.strokeLength || 125;
        const distanceMm = (Math.abs(dest - pos) / 100) * strokeLength;
        const minSpeed = settings.minSpeed || 32;
        const maxSpeed = settings.maxSpeed || 450;
        const speed = Math.max(minSpeed, Math.min(maxSpeed, this.paceToSpeed(this.cur.pace, settings) * speedFactor));
        const duration = Math.max(120, Math.round((distanceMm / speed) * 1000));

        PlaybackState.currentPosition = dest;
        DeviceCommands.linear(Math.round(dest), duration);

        const pause = (this.dir > 0 && this.cur.hold > 0 && !this.stopping) ? this.cur.hold : 0;
        this.dir = -this.dir;
        this.timer = setTimeout(() => this.tick(), duration + pause + extraPause);
        this.report();
    },

    /**
     * "Edge" was called: hold still right away, and keep still for a hold of random length.
     * When the hold ends the character starts again by himself.
     */
    edge(settings) {
        const pos = MoveTracker.estimate();
        Session.preEdgePace = Math.round(this.tgt.pace) || Math.round(this.cur.pace) || 3;
        this.halt();
        this.pending = null;
        updatePlaybackStatus(false);
        if (deviceAvailable()) {
            DeviceCommands.linear(Math.round(pos), 150);
            PlaybackState.currentPosition = Math.round(pos);
        }
        const cooldown = this.startHold(settings);
        console.log(`${LOG_PREFIX} Edge ${Session.edgeCount}${Session.edgeGoal ? '/' + Session.edgeGoal : ''}: holding for ${(cooldown / 1000).toFixed(0)}s`);
        this.report();
    },

    /**
     * Keeps everything still for a hold of random length. When it ends, the character starts
     * again by himself unless the user already asked for something.
     * @returns {number} The hold length in ms.
     */
    startHold(settings) {
        const minSec = Math.max(0, Number(settings.edgeCooldownSec ?? 8));
        const maxSec = Math.max(minSec, Number(settings.edgeCooldownMaxSec ?? minSec));
        const cooldown = Math.round((minSec + Math.random() * (maxSec - minSec)) * 1000);
        this.cooldownUntil = Date.now() + cooldown;
        if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
        this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = null;
            this.cooldownUntil = 0;
            const p = this.pending;
            this.pending = null;
            if (p && Number(p.pace) > 0) {
                // The user already asked to go again during the hold
                this.setTarget(p);
                scheduleIdleFollowUp();
            } else if (!Session.stopRequested) {
                // Nobody said anything: the character picks it up again on his own
                triggerFollowUp('edge-resume');
            }
            this.report();
        }, cooldown);
        return cooldown;
    },

    /**
     * "I'm close": drop to the slowest pace at once and keep the same stroke going.
     * The character then decides whether to hold there or stop.
     */
    backOff() {
        if (!this.active) return;
        Session.preEdgePace = Math.round(this.tgt.pace) || Math.round(this.cur.pace) || 3;
        this.build = null;
        this.stopping = false;
        this.easedOut = false;
        this.fx = null;
        this.jitter = 0;
        this.tgt.pace = 1;
        this.cur.pace = Math.min(this.cur.pace, 1);
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.dir = -this.dir; // carry on in the direction it was already going, just slowly
        console.log(`${LOG_PREFIX} Close call: dropped to pace 1`);
        this.tick();
    },

    /** Forgets an edge cooldown and anything waiting behind it. */
    cancelCooldown() {
        if (this.cooldownTimer) {
            clearTimeout(this.cooldownTimer);
            this.cooldownTimer = null;
        }
        this.cooldownUntil = 0;
        this.pending = null;
    },

    /** Stops the engine's timer without sending anything to the device. */
    halt() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.active = false;
        this.stopping = false;
        this.easedOut = false;
        this.build = null;
        this.fx = null;
        this.cur.pace = 0;
    },

    /** Shows the live pace and edge count in the extension panel. */
    report() {
        const el = document.getElementById("ham_playback_status");
        if (!el) return;
        let text;
        if (Date.now() < this.cooldownUntil) {
            text = "Edge hold";
        } else if (this.active) {
            text = `Pace ${this.cur.pace.toFixed(1)}`;
            if (!this.stopping && Math.abs(this.tgt.pace - this.cur.pace) > 0.05) text += ` > ${this.tgt.pace}`;
            if (this.build) text += ` (${this.build.dir > 0 ? 'building' : 'easing'} to ${this.build.to})`;
        } else if (PlaybackState.isPlaying) {
            text = "Playing";
        } else {
            text = "Idle";
        }
        if (Session.edgeCount > 0 || Session.edgeGoal > 0) {
            text += ` | Edges ${Session.edgeCount}${Session.edgeGoal ? '/' + Session.edgeGoal : ''}`;
        }
        el.textContent = text;
    },
};

/**
 * [glide mod] Halts everything at once and holds the device where it is (no jump to 0).
 */
function emergencyStop() {
    const pos = MoveTracker.estimate();
    Glide.cancelCooldown();
    clearFollowUpTimers();
    Session.stopRequested = true;
    Session.queuedFollowUp = null;
    stopPlayback();
    Glide.report();
    if (IntifaceState.defaultDeviceIndex === null) return;
    DeviceCommands.linear(Math.round(pos), 150);
    PlaybackState.currentPosition = Math.round(pos);
    if (IntifaceState.deviceCapabilities.canStopDevice) {
        setTimeout(() => {
            intifaceSend({
                StopDeviceCmd: {
                    Id: IntifaceState.messageId++,
                    DeviceIndex: IntifaceState.defaultDeviceIndex,
                }
            });
        }, 200);
    }
    console.log(`${LOG_PREFIX} Emergency stop at ${Math.round(pos)}%`);
}

/** [glide mod] True while something is going on that the character should keep driving. */
function sessionHot() {
    return (Glide.active && !Glide.stopping) || Date.now() < Glide.cooldownUntil;
}

function clearFollowUpTimers() {
    if (Session.idleTimer) {
        clearTimeout(Session.idleTimer);
        Session.idleTimer = null;
    }
    if (Session.fallbackTimer) {
        clearTimeout(Session.fallbackTimer);
        Session.fallbackTimer = null;
    }
}

/**
 * [glide mod] After the character's reply, start a timer: if the user stays quiet while the
 * touch is going, the character speaks again by himself.
 */
function scheduleIdleFollowUp(delayMs = null) {
    if (Session.idleTimer) {
        clearTimeout(Session.idleTimer);
        Session.idleTimer = null;
    }
    const settings = getConfig();
    if (!settings.enabled || !settings.glideMode || settings.autoFollowUp === false) return;
    if (Session.stopRequested) return;
    if (Date.now() < Glide.cooldownUntil) return; // the end of an edge hold has its own follow-up
    if (!(Glide.active && !Glide.stopping)) return;
    const max = Math.max(0, Number(settings.followUpMax ?? 8));
    if (Session.unprompted >= max) return;
    const base = Math.max(10, Number(settings.followUpSec) || 40) * 1000;
    const delay = delayMs ?? Math.round(base * (0.7 + Math.random() * 0.7));
    Session.idleTimer = setTimeout(() => {
        Session.idleTimer = null;
        if (!(Glide.active && !Glide.stopping)) return;
        triggerFollowUp(Session.unprompted + 1 >= max ? 'final' : 'idle');
    }, delay);
}

/**
 * [glide mod] Asks the character for a reply the user did not prompt.
 * @param {'idle'|'final'|'edge-resume'} reason
 */
async function triggerFollowUp(reason) {
    const settings = getConfig();
    if (!settings.enabled || !settings.glideMode || settings.autoFollowUp === false) return;
    if (Session.stopRequested) return;
    const ctx = window.SillyTavern?.getContext();
    if (!ctx || typeof ctx.executeSlashCommandsWithOptions !== 'function') return;
    if (!ctx.chat || ctx.chat.length === 0) return;

    if (Session.generating) {
        Session.queuedFollowUp = reason; // runs when the current reply has finished
        return;
    }

    // Never talk over the user: if they are typing, look again in a few seconds
    const box = document.getElementById('send_textarea');
    if (box && String(box.value || '').trim() !== '') {
        if (Session.idleTimer) clearTimeout(Session.idleTimer);
        Session.idleTimer = setTimeout(() => {
            Session.idleTimer = null;
            triggerFollowUp(reason);
        }, 8000);
        return;
    }

    Session.followUpReason = reason;
    Session.awaitingFollowUp = true;
    Session.unprompted++;
    updateSessionNote();

    if (reason === 'edge-resume') {
        // If no reply arrives at all, start again gently anyway
        if (Session.fallbackTimer) clearTimeout(Session.fallbackTimer);
        Session.fallbackTimer = setTimeout(() => {
            Session.fallbackTimer = null;
            if (Session.awaitingFollowUp && !Glide.active && !Session.stopRequested && Date.now() >= Glide.cooldownUntil) {
                Session.awaitingFollowUp = false;
                Glide.setTarget({ pace: 2, min: 10, max: 90, buildTo: Math.max(3, Math.min(10, Session.preEdgePace || 3)) });
                scheduleIdleFollowUp();
            }
        }, 20000);
    }

    try {
        if (settings.debugMode) console.log(`${LOG_PREFIX} Unprompted reply (${reason})`);
        await ctx.executeSlashCommandsWithOptions('/trigger');
    } catch (err) {
        console.warn(`${LOG_PREFIX} Could not trigger a follow-up:`, err);
        Session.followUpReason = null;
    }
}

/**
 * [glide mod] Gives the character the real state of the session (pace, edges) on every turn,
 * as a hidden note at the end of the chat.
 */
function updateSessionNote() {
    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
        const settings = getConfig();
        const KEY = 'handy_ai_motion_state';
        if (!settings.enabled || !settings.glideMode || settings.sessionNote === false) {
            ctx.setExtensionPrompt(KEY, '', 1, 0);
            return;
        }
        const user = ctx.name1 || 'the user';
        const char = ctx.name2 || 'the character';
        const parts = [];
        const cooling = Date.now() < Glide.cooldownUntil;
        if (Glide.active && !Glide.stopping) {
            let s = `${char}'s touch is moving right now at pace ${Math.round(Glide.tgt.pace)}`;
            if (Glide.build) s += ` and ${Glide.build.dir > 0 ? 'climbing' : 'easing'} on its own toward ${Glide.build.to}`;
            parts.push(s + '.');
        } else {
            parts.push(`${char}'s hand is still right now.`);
        }
        if (Session.followUpReason === 'edge-resume') {
            parts.push(`The edge hold is over and ${user} is waiting in silence. ${char} speaks first and starts again now without being asked: this reply ends at pace 1 or 2, building to ${Math.max(3, Math.min(10, Session.preEdgePace || 3))}.`);
        } else if (Session.edgePendingAck || cooling) {
            parts.push(`${user} just called an edge, and the touch has already stopped on its own. This reply must end with the hand still. ${char} will start again by himself in a moment, so he does not ask ${user} to say when.`);
        }
        if (Session.closePendingAck) {
            parts.push(`${user} just said he is close, and the touch has already dropped to pace 1 on its own. ${char} decides whether to keep it at pace 1 or stop completely, and does not go above pace 2 in this reply.`);
        }
        if (Session.followUpReason === 'idle') {
            parts.push(`${user} has stayed quiet. ${char} carries on by himself with a short reply: he speaks first, keeps the scene moving, and decides what happens next (hold, change the pace by 1, build, tease, change the stroke). He does not ask ${user} to answer.`);
        } else if (Session.followUpReason === 'final') {
            parts.push(`${user} has stayed quiet for a long time. ${char} eases off: this reply ends with the hand still, and he checks in gently.`);
        }
        if (Session.edgeCount > 0 || Session.edgeGoal > 0) {
            let s = `Edges so far: ${Session.edgeCount}`;
            if (Session.edgeGoal > 0) {
                s += ` of a goal of ${Session.edgeGoal}.`;
                s += Session.edgeCount >= Session.edgeGoal
                    ? ` The goal is reached, so ${char} may let ${user} finish.`
                    : ` ${char} does not let ${user} finish before the goal.`;
            } else {
                s += '.';
            }
            parts.push(s);
        }
        const text = `[Session note for ${char}. Never mention or repeat this note. ${parts.join(' ')}]`;
        ctx.setExtensionPrompt(KEY, text, 1, 0, false, 0);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Could not update session note:`, err);
    }
}

/**
 * [glide mod] Reads an edge goal from the user's message, e.g. "edge goal 5" or "edge me five times".
 * @returns {number} The goal, or 0 if the message does not set one.
 */
function parseEdgeGoal(text) {
    if (!text) return 0;
    const lower = String(text).toLowerCase();
    const num = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';
    const m = lower.match(new RegExp(`\\bedge goal\\s*(?:of|is|to|:|=)?\\s*${num}\\b`))
        || lower.match(new RegExp(`\\bedge me\\s+${num}\\s+times?\\b`))
        || lower.match(new RegExp(`\\b(?:goal|want|do|give me|make it|for)\\D{0,15}${num}\\s+edges\\b`));
    if (!m) return 0;
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const n = words[m[1]] ?? parseInt(m[1]);
    return (isFinite(n) && n >= 1 && n <= 50) ? n : 0;
}

/**
 * [glide mod] True if the user's message calls an edge: a short message with the word "edge",
 * or a phrase such as "I'm close".
 */
function isEdgeCall(text, wordList) {
    if (!text) return false;
    const lower = String(text).toLowerCase().replace(/[‘’]/g, "'");
    const wordCount = lower.split(/\s+/).filter(Boolean).length;
    const phrases = String(wordList || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    for (const phrase of phrases) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = lower.match(new RegExp(`\\b${escaped}\\b`));
        if (!m) continue;
        // A single word such as "edge" only counts in a short message
        if (!phrase.includes(' ') && wordCount > 5) continue;
        const before = lower.slice(Math.max(0, m.index - 12), m.index);
        if (/(\bnot|n't|\bno|\bnever)\s+$/.test(before)) continue;
        return true;
    }
    return false;
}

/**
 * [glide mod] Reads the motion line at the end of a reply, e.g.
 * "*Pace 4: full strokes, whole length, even rhythm.*" or "*Julian's hand is still.*"
 * @param {string} text - The full reply text.
 * @returns {{pace:number,min:number,max:number,hold:number}|null} Target, or null if no motion line found.
 */
function parseMotionLine(text) {
    if (!text) return null;
    const lines = String(text).split(/\r?\n/).map(l => l.replace(/[*_`]/g, '').trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const line = lines[lines.length - 1].toLowerCase();

    const paceMatch = line.match(/\bpace\s*:?\s*(\d+(?:\.\d+)?)/);
    if (!paceMatch) {
        if (/\b(still|stopped|resting|off you|not touching|nothing is touching)\b/.test(line)) {
            return { pace: 0, min: 10, max: 90, hold: 0 };
        }
        return null;
    }

    const pace = parseFloat(paceMatch[1]);
    let min = 10, max = 90;
    if (/\b(tip|head|top)\b/.test(line)) { min = 70; max = 100; }
    else if (/\bbase\b|\bbottom\b/.test(line)) { min = 0; max = 30; }
    else if (/\bupper half\b/.test(line)) { min = 50; max = 100; }
    else if (/\blower half\b/.test(line)) { min = 0; max = 50; }
    else if (/\bmiddle\b|\bmid\b/.test(line)) { min = 35; max = 65; }
    else if (/\bshort\b/.test(line)) { min = 35; max = 65; }

    const hold = /\bpaus(e|es|ing)\b/.test(line) ? 800 : 0;

    // Rhythm: "even" is exact and steady; "natural" (or varied, teasing) adds small variation
    let vary = 1;
    if (/\beven\b/.test(line) && !/\b(natural|varied|varying|teasing|playful|uneven)\b/.test(line)) vary = 0;

    // "building to 7" / "easing to 2": the pace then changes one level at a time on its own
    let buildTo = null;
    const up = line.match(/\b(?:building|climbing|rising)(?:\s+up)?(?:\s+to\s+(\d+(?:\.\d+)?))?/);
    const down = line.match(/\b(?:easing|slowing|winding)(?:\s+down)?(?:\s+to\s+(\d+(?:\.\d+)?))?/);
    if (up) buildTo = up[1] ? parseFloat(up[1]) : Math.min(10, pace + 2);
    else if (down) buildTo = down[1] ? parseFloat(down[1]) : Math.max(1, pace - 2);

    return { pace, min, max, hold, vary, buildTo };
}

/**
 * [glide mod] True if the user's message asks to stop (but not "don't stop").
 */
function hasStopWord(text, settings) {
    if (!text) return false;
    const words = String(settings.stopWords || 'stop,pause').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    if (words.length === 0) return false;
    const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const lower = String(text).toLowerCase();
    const negated = new RegExp(`\\b(don'?t|do not|dont|never|not|no need to)\\s+(${escaped})\\b`);
    const cleaned = lower.replace(new RegExp(negated.source, 'g'), ' ');
    return new RegExp(`\\b(${escaped})\\b`).test(cleaned);
}

/* ================================================================================================
   SLOW MOVEMENT EXPANSION
   Breaks slow movements into step-and-hold segments to preserve timing while staying
   within device speed limits. Creates a subtle "pulsing" or "teasing" motion.
================================================================================================ */
/**
 * Expands all slow movements in start and loop arrays.
 * Ensures proper transitions between the end of the start phase and the beginning of the loop phase,
 * and ensures the loop phase forms a complete cycle.
 * 
 * @param {Array} movements - Array of { delay, pos } objects
 * @param {object} settings - Settings object
 * @param {string} phaseName - "start" or "loop" for debug logging
 * @param {number} endPos - Optional final position (0-100), used between start and loop, and for loop cycle completion
 * @returns {Array} Expanded movements array
 */
function expandMovements(movements, settings, phaseName = "movements", endPos = null) {
    if (!settings.expandSlowMovements) {
        return movements;
    }
    
    if (!Array.isArray(movements) || movements.some(m => typeof m.pos !== 'number' || typeof m.delay !== 'number')) {
        console.warn(`${LOG_PREFIX} Invalid movements data`);
        return [];
    }

    const expanded = [];
    let currentPosition = 0;
    // If the phaseName is start or the start is empty, PlaybackState.currentPosition, or fall back to 0. If the phaseName is loop, use the first position of the loop
    if (phaseName === "start") {
        currentPosition = (typeof PlaybackState.currentPosition === 'number') ? PlaybackState.currentPosition : 0;
    } else if (phaseName === "loop") {
        currentPosition = movements.length > 0 ? movements[0].pos : (typeof PlaybackState.currentPosition === 'number' ? PlaybackState.currentPosition : 0);
    } else {
        return movements;
    }

    // Only for start phase, ensure we transition smoothly to the first loop position if endPos is provided
    if (phaseName === "start") {
        for (let i = 0; i < movements.length; i++) {
            const movement = movements[i];
            const fromPos = currentPosition;
            const toPos = movement.pos;
            const duration = movement.delay > 0 ? movement.delay : DEFAULT_MOVEMENT_DURATION;
        
            // Expand this movement if needed
            const expandedSteps = expandSlowMovement(fromPos, toPos, duration, settings);
            expanded.push(...expandedSteps);
        
            // Track position for next movement
            currentPosition = toPos;
        }
        // Handle transition between start and loop
        if (endPos !== null && expanded.length > 0) {
            const lastPos = expanded[expanded.length - 1].pos;
            const duration = movements[movements.length - 1]?.delay; // Use the duration of the last movement for the transition

            if (duration && lastPos !== endPos) {
                // Add a transition movement from the last position to the end position
                const transitionSteps = expandSlowMovement(lastPos, endPos, duration, settings);
                expanded.push(...transitionSteps);
            }
        }
    } else if (phaseName === "loop") {
        for (let i = 0; i < movements.length; i++) {
            const movement = movements[i];
            const fromPos = movement.pos;
            const toPos = (i < movements.length - 1) ? movements[i + 1].pos : movements[0].pos;
            const duration = movement.delay > 0 ? movement.delay : DEFAULT_MOVEMENT_DURATION;
        
            // Expand this movement if needed
            const expandedSteps = expandSlowMovement(fromPos, toPos, duration, settings);
            expanded.push(...expandedSteps);
        
            // Track position for next movement
            currentPosition = toPos;
        }
    }
    
    if (settings.debugMode && expanded.length !== movements.length) {
        console.log(`${LOG_PREFIX} Expanded ${phaseName}: ${movements.length} -> ${expanded.length} movements`);
    }
    
    return expanded;
}

/**
 * Expands a slow movement into multiple step-and-hold segments.
 * Each step moves a small amount at minimum speed, then holds to maintain total timing.
 * 
 * @param {number} fromPos - Starting position (0-100%)
 * @param {number} toPos - Target position (0-100%)
 * @param {number} duration - Total duration in ms
 * @param {object} settings - Settings object with minSpeed, strokeLength, stepSize
 * @returns {Array} Array of movement objects { delay, pos }
 */
function expandSlowMovement(fromPos, toPos, duration, settings) {
    const strokeLength = settings.strokeLength || 125;
    const minSpeed = settings.minSpeed || 32;
    const stepSize = settings.stepSize || 1;
    
    const positionDelta = Math.abs(toPos - fromPos);
    
    // No movement needed
    if (positionDelta < 0.01) {
        return [{ delay: duration, pos: toPos }];
    }
    
    // Calculate if expansion is needed
    const distanceMm = (positionDelta / 100) * strokeLength;
    const requestedSpeed = distanceMm / (duration / 1000);
    
    // If speed is within limits, return original movement
    if (requestedSpeed >= minSpeed) {
        return [{ delay: duration, pos: toPos }];
    }
    
    // Need to expand into step-and-hold segments
    const direction = toPos > fromPos ? 1 : -1;
    const steps = [];
    
    // Calculate number of steps (use configured step size, but ensure at least 1 step)
    const actualStepSize = Math.min(stepSize, positionDelta);
    const numSteps = Math.max(1, Math.ceil(positionDelta / actualStepSize));
    const actualStepDelta = positionDelta / numSteps; // Distribute evenly
    
    // Calculate timing per step
    const distancePerStepMm = (actualStepDelta / 100) * strokeLength;
    const moveTimePerStep = Math.max(1, Math.round((distancePerStepMm / minSpeed) * 1000));
    const totalTimePerStep = duration / numSteps;
    const holdTimePerStep = Math.max(0, Math.round(totalTimePerStep - moveTimePerStep));
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Expanding slow movement: ${fromPos}% -> ${toPos}% over ${duration}ms`);
        console.log(`${LOG_PREFIX} Requested speed: ${requestedSpeed.toFixed(1)}mm/s (min: ${minSpeed}mm/s)`);
        console.log(`${LOG_PREFIX} Expanding to ${numSteps} steps: ${moveTimePerStep}ms move + ${holdTimePerStep}ms hold each`);
    }
    
    let currentPos = fromPos;
    for (let i = 1; i <= numSteps; i++) {
        const nextPos = i === numSteps ? toPos : currentPos + (direction * actualStepDelta);
        
        steps.push({ 
            delay: moveTimePerStep, 
            pos: Math.round(nextPos * 100) / 100 // Round to 2 decimal places
        });
        
        if (holdTimePerStep > 0 && i < numSteps) {
            steps.push({ 
                delay: holdTimePerStep, 
                pos: Math.round(nextPos * 100) / 100 
            });
        }
        
        currentPos = nextPos;
    }
    
    return steps;
}

/* ================================================================================================
   JSON EXTRACTION HELPER
================================================================================================ */
/**
 * Extracts JSON object from LLM response, handling various formats:
 * - Markdown code blocks: ```json { ... } ```
 * - Plain JSON objects
 * - JSON embedded in text before/after explanations
 * - JSON with comments (single-line // and multi-line slash-asterisk style)
 */
function extractJsonFromResponse(response, debugMode = false) {
    if (!response || typeof response !== 'string') {
        return null;
    }
    
    // Handle empty or whitespace-only responses
    const trimmedResponse = response.trim();
    if (!trimmedResponse || trimmedResponse === '```') {
        if (debugMode) {
            console.log(`${LOG_PREFIX} Empty or incomplete response`);
        }
        return null;
    }
    
    // Method 1: Try to extract from markdown code block first (```json ... ``` or ``` ... ```)
    const codeBlockMatch = trimmedResponse.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
        const codeContent = codeBlockMatch[1].trim();
        if (debugMode) {
            console.log(`${LOG_PREFIX} Found code block content:`, codeContent.substring(0, 200));
        }
        
        // Skip empty code blocks
        if (!codeContent) {
            if (debugMode) {
                console.log(`${LOG_PREFIX} Code block is empty`);
            }
        } else {
            // Strip comments from the code block content
            const cleanedContent = stripJsonComments(codeContent);
            
            // Try to parse the cleaned code block content
            try {
                JSON.parse(cleanedContent);
                return cleanedContent;
            } catch {
                // Code block might contain extra content, try to extract JSON from it
                const jsonInCode = extractJsonObject(cleanedContent, debugMode);
                if (jsonInCode) return jsonInCode;
            }
        }
    }
    
    // Method 1b: Handle incomplete code blocks (opening ``` without closing)
    const incompleteBlockMatch = trimmedResponse.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (incompleteBlockMatch && !codeBlockMatch) {
        const codeContent = incompleteBlockMatch[1].trim();
        if (debugMode) {
            console.log(`${LOG_PREFIX} Found incomplete code block:`, codeContent.substring(0, 200));
        }
        
        if (codeContent) {
            const cleanedContent = stripJsonComments(codeContent);
            const jsonInCode = extractJsonObject(cleanedContent, debugMode);
            if (jsonInCode) return jsonInCode;
        }
    }
    
    // Method 2: Look for JSON object with "start" and "loop" keys anywhere in response
    // First strip comments from the whole response
    const cleanedResponse = stripJsonComments(trimmedResponse);
    const jsonExtracted = extractJsonObject(cleanedResponse, debugMode);
    if (jsonExtracted) return jsonExtracted;
    
    // Method 3: Try to find any valid JSON object in the response
    const anyJsonMatch = cleanedResponse.match(/\{[\s\S]*?\}/g);
    if (anyJsonMatch) {
        for (const match of anyJsonMatch) {
            try {
                const parsed = JSON.parse(match);
                if (parsed.start || parsed.loop || parsed.pace !== undefined) {
                    if (debugMode) {
                        console.log(`${LOG_PREFIX} Found JSON object with movement data`);
                    }
                    return match;
                }
            } catch {
                // Continue to next match
            }
        }
    }
    
    return null;
}

/**
 * Strips comments from JSON-like content.
 * Handles single-line (//) and multi-line (slash-asterisk) comment styles.
 * @param {string} str - The string to process.
 * @returns {string} The string with comments removed.
 */
function stripJsonComments(str) {
    if (!str) return str;
    
    let result = '';
    let i = 0;
    let inString = false;
    let escapeNext = false;
    
    while (i < str.length) {
        const char = str[i];
        const nextChar = str[i + 1];
        
        if (escapeNext) {
            result += char;
            escapeNext = false;
            i++;
            continue;
        }
        
        if (char === '\\' && inString) {
            result += char;
            escapeNext = true;
            i++;
            continue;
        }
        
        if (char === '"') {
            inString = !inString;
            result += char;
            i++;
            continue;
        }
        
        // Only process comments outside strings
        if (!inString) {
            // Single-line comment // ... until newline
            if (char === '/' && nextChar === '/') {
                // Skip until end of line
                i += 2;
                while (i < str.length && str[i] !== '\n' && str[i] !== '\r') {
                    i++;
                }
                // Keep the newline for formatting
                continue;
            }
            
            // Multi-line comment /* ... */
            if (char === '/' && nextChar === '*') {
                i += 2;
                while (i < str.length - 1) {
                    if (str[i] === '*' && str[i + 1] === '/') {
                        i += 2;
                        break;
                    }
                    i++;
                }
                continue;
            }
        }
        
        result += char;
        i++;
    }
    
    return result;
}

/**
 * Extracts a complete JSON object from text, handling nested braces.
 * @param {string} text - The text containing the JSON object.
 * @param {boolean} [debugMode=false] - Whether to log debug information.
 * @returns {string|null} The extracted JSON string or null if not found.
 */
function extractJsonObject(text, debugMode = false) {
    // Find the position of "start" or "loop" key to locate the JSON object
    const keyMatch = text.match(/"start"\s*:\s*\[|"loop"\s*:\s*\[/);
    if (!keyMatch) return null;
    
    // Find the opening brace before this key
    const keyIndex = keyMatch.index;
    let braceIndex = text.lastIndexOf('{', keyIndex);
    if (braceIndex === -1) return null;
    
    // Count braces to find the matching closing brace
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    
    for (let i = braceIndex; i < text.length; i++) {
        const char = text[i];
        
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        
        if (char === '"') {
            inString = !inString;
            continue;
        }
        
        if (!inString) {
            if (char === '{') depth++;
            else if (char === '}') {
                depth--;
                if (depth === 0) {
                    // Found the complete JSON object
                    const jsonStr = text.substring(braceIndex, i + 1);
                    if (debugMode) {
                        console.log(`${LOG_PREFIX} Extracted JSON object (${jsonStr.length} chars)`);
                    }
                    return jsonStr;
                }
            }
        }
    }
    
    return null;
}

/* ================================================================================================
   LLM ANALYSIS
================================================================================================ */
async function analyzeMessageWithLLM(message, chat) {
    const settings = getConfig();
    
    if (!settings.enabled) {
        console.log(`${LOG_PREFIX} Extension disabled, skipping analysis`);
        return null;
    }

    const retryOnInvalid = settings.retryOnInvalid !== false; // Default to true
    const maxRetries = settings.maxRetries || 3;
    
    let attempt = 0;
    let lastError = null;
    
    while (attempt <= (retryOnInvalid ? maxRetries : 0)) {
        attempt++;
        
        if (attempt > 1) {
            console.log(`${LOG_PREFIX} Retry attempt ${attempt - 1}/${maxRetries}...`);
        }
        
        const result = await performLLMAnalysis(message, settings, chat);
        
        if (result.success) {
            return result.data;
        }
        
        lastError = result.error;
        
        // If retry is disabled or we've exhausted retries, break
        if (!retryOnInvalid || attempt > maxRetries) {
            break;
        }
        
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.error(`${LOG_PREFIX} All ${attempt} attempt(s) failed. Last error: ${lastError}`);
    return null;
}

/**
 * Performs a single LLM analysis attempt.
 * Returns { success: boolean, data?: parsed JSON, error?: string }
 * @param {string} message - The message to analyze.
 * @param {Object} settings - The configuration settings.
 * @param {Array} fullContext - The full conversation context (array of messages).
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>} The result of the analysis.
 */
async function performLLMAnalysis(message, settings, fullContext = []) {
    let analysisPrompt;

    // Check if patterns mode is enabled
    if (settings.usePatternsFile) {
        const patterns = await loadPatterns();
        
        if (patterns.length === 0) {
            console.warn(`${LOG_PREFIX} Patterns mode enabled but no patterns loaded`);
            // Fall back to standard analysis
            analysisPrompt = settings.analysisPrompt.replace("{{message}}", message);
        } else {
            // Use patterns prompt
            const patternData = generatePatternDataForLLM(patterns);
            analysisPrompt = (settings.patternsPrompt || defaultSettings.patternsPrompt)
                .replace("{{message}}", message)
                .replace("{{pattern_data}}", patternData);
            
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Using patterns mode with ${patterns.length} patterns`);
            }
            
            // Perform pattern-based analysis
            return await performPatternAnalysis(message, settings, patterns, analysisPrompt);
        }
    } else {
        // Standard analysis
        analysisPrompt = settings.analysisPrompt.replace("{{message}}", message);
    }
    
    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Analysis prompt length: ${analysisPrompt.length} chars`);
    }

    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx) {
            return { success: false, error: "SillyTavern context not available" };
        }

        let response;
        let usedMethod = "unknown";
        
        // Helper function for isolated/raw generation (no context)
        const tryIsolatedGeneration = async () => {
            if (typeof ctx.generateRaw === 'function') {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Trying generateRaw (isolated prompt)`);
                }
                return { response: await ctx.generateRaw(analysisPrompt), method: 'generateRaw' };
            }
            return null;
        };
        
        // Helper function for quiet generation (with extension context)
        const tryQuietGeneration = async () => {
            if (typeof ctx.generateQuietPrompt === 'function') {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Trying generateQuietPrompt (with context)`);
                }
                return { response: await ctx.generateQuietPrompt(analysisPrompt, false, false, ''), method: 'generateQuietPrompt' };
            }
            return null;
        };
        
        // Try isolated generation first (preferred for analysis tasks)
        const isolatedResult = await tryIsolatedGeneration();
        if (isolatedResult) {
            response = isolatedResult.response;
            usedMethod = isolatedResult.method;
        }
        
        // Fall back to quiet generation if isolated failed or returned empty
        if (!response && response !== '') {
            const quietResult = await tryQuietGeneration();
            if (quietResult) {
                response = quietResult.response;
                usedMethod = quietResult.method;
            }
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Used method: ${usedMethod}`);
            console.log(`${LOG_PREFIX} LLM response length: ${response?.length || 0} chars`);
            if (response) {
                console.log(`${LOG_PREFIX} LLM response preview:`, response.substring(0, 500));
            }
        }
        
        if (!response || response.trim() === '') {
            return { success: false, error: "Empty response from LLM" };
        }
        
        // Extract JSON from the response
        const jsonStr = extractJsonFromResponse(response, settings.debugMode);
        
        if (!jsonStr) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} No valid JSON found in response`);
            }
            return { success: false, error: "No valid JSON found in response" };
        }
        
        try {
            const parsed = JSON.parse(jsonStr);
            
            // Validate the parsed data has required structure
            if (!parsed.start && !parsed.loop && parsed.pace === undefined) {
                return { success: false, error: "JSON missing 'start' or 'loop' arrays" };
            }
            
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Successfully parsed movement data`);
            }
            
            return { success: true, data: parsed };
        } catch (parseErr) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} JSON parse error:`, parseErr);
            }
            return { success: false, error: `JSON parse error: ${parseErr.message}` };
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} LLM analysis error:`, err);
        return { success: false, error: err.message || "Unknown error" };
    }
}

/**
 * Performs pattern-based LLM analysis.
 * @param {string} message - The message to analyze.
 * @param {Object} settings - The configuration settings.
 * @param {Array} patterns - Available patterns.
 * @param {string} analysisPrompt - The prepared prompt.
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>} The result.
 */
async function performPatternAnalysis(message, settings, patterns, analysisPrompt) {
    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx) {
            return { success: false, error: "SillyTavern context not available" };
        }

        let response;
        
        // Try generateRaw first
        if (typeof ctx.generateRaw === 'function') {
            response = await ctx.generateRaw(analysisPrompt);
        } else if (typeof ctx.generateQuietPrompt === 'function') {
            response = await ctx.generateQuietPrompt(analysisPrompt, false, false, '');
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Pattern selection response:`, response?.substring(0, 500));
        }
        
        if (!response || response.trim() === '') {
            return { success: false, error: "Empty response from LLM for pattern selection" };
        }
        
        // Parse the pattern selection
        const selection = parsePatternSelection(response, settings.debugMode);
        
        if (!selection) {
            return { success: false, error: "Could not parse pattern selection from LLM response" };
        }
        
        // Find the selected pattern
        const pattern = findPatternByName(selection.pattern, patterns);
        
        if (!pattern) {
            return { success: false, error: `Pattern "${selection.pattern}" not found` };
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Selected pattern: ${selection.pattern}, speed: ${selection.speed_percent}%, range: ${selection.range_min}-${selection.range_max}`);
        }
        
        // Apply modifiers to the pattern
        const modifiedPattern = applyPatternModifiers(
            pattern,
            selection.speed_percent,
            selection.range_min,
            selection.range_max
        );
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Modified pattern:`, modifiedPattern);
        }
        
        return { success: true, data: modifiedPattern };
    } catch (err) {
        console.error(`${LOG_PREFIX} Pattern analysis error:`, err);
        return { success: false, error: err.message || "Unknown error" };
    }
}

/* ================================================================================================
   EVENT HANDLERS AND INITIALIZATION
================================================================================================ */
/**
 * Handles incoming chat messages and triggers LLM analysis.
 * @param {number} messageId - The ID of the incoming message.
 */
async function onMessageReceived(messageId) {
    const settings = getConfig();
    
    if (!settings.enabled) {
        return;
    }
    
    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx) {
            console.warn(`${LOG_PREFIX} No SillyTavern context available`);
            return;
        }
        
        // Get the message at the specified index
        const chat = ctx.chat;
        if (!chat || !chat[messageId]) {
            return;
        }
        
        const message = chat[messageId];
        
        // Only process AI/user messages (not system messages)
        if (message.is_system) {
            return;
        }
        
        // Get the message text
        let messageText = message.mes || message.message || '';
        
        if (!messageText || messageText.trim() === '') {
            return;
        }
        
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Processing message ${messageId}: ${messageText.substring(0, 100)}...`);
        }
        
        // [glide mod] Only the AI's replies drive the device
        if (message.is_user) {
            return;
        }
        const answeredClose = Session.closePendingAck;
        Session.edgePendingAck = false;
        Session.closePendingAck = false;
        Session.followUpReason = null;
        Session.awaitingFollowUp = false;

        // [glide mod] Fast path: read "Pace N ..." from the reply's last line, no LLM call needed
        if (settings.glideMode && settings.fastParse) {
            const target = parseMotionLine(messageText);
            if (target) {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Motion line parsed directly:`, target);
                }
                Glide.setTarget(target);
                if (answeredClose && Number(target.pace) <= 0 && Date.now() >= Glide.cooldownUntil && !Session.stopRequested) {
                    // He chose to stop completely after "I'm close": hold, then he starts again by himself
                    Glide.startHold(settings);
                    Glide.report();
                }
                scheduleIdleFollowUp();
                return;
            }
        }

        // Analyze the message with LLM
        const movementData = await analyzeMessageWithLLM(messageText, chat);
        
        if (movementData) {
            if (settings.glideMode && movementData.pace !== undefined) {
                // [glide mod] pace-style result: blend toward it
                Glide.setTarget(movementData);
                scheduleIdleFollowUp();
            } else {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Starting playback with movement data`);
                }
                startPlayback(movementData);
            }
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Error in onMessageReceived:`, err);
    }
}

/**
 * Opens the patterns.json file in the system's default editor.
 */
function openPatternsFile() {
    // In SillyTavern, we can use the built-in file open functionality
    // This will open the file in a new browser tab for editing
    const patternsUrl = `${extensionFolderPath}/patterns.json`;
    window.open(patternsUrl, '_blank');
}

/**
 * Reloads patterns from the patterns.json file.
 */
async function reloadPatterns() {
    cachedPatterns = null;
    const patterns = await loadPatterns();
    
    if (patterns.length > 0) {
        toastr?.success?.(`Loaded ${patterns.length} patterns`, 'Handy AI Motion');
    } else {
        toastr?.warning?.('No patterns loaded', 'Handy AI Motion');
    }
    
    return patterns;
}

/**
 * Initializes the extension settings and UI.
 */
async function initExtension() {
    // [glide mod] bug fix: the settings object was never created, so no setting change was ever kept
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const settings = getConfig();
    
    // Create settings HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings2').append(settingsHtml);
    
    // Initialize UI elements with current settings
    $('#ham_enabled').prop('checked', settings.enabled);
    $('#ham_auto_connect').prop('checked', settings.autoConnect);
    $('#ham_debug_mode').prop('checked', settings.debugMode);
    $('#ham_intiface_address').val(settings.intifaceAddress);
    $('#ham_min_speed').val(settings.minSpeed);
    $('#ham_max_speed').val(settings.maxSpeed);
    $('#ham_stroke_length').val(settings.strokeLength);
    $('#ham_expand_slow').prop('checked', settings.expandSlowMovements);
    $('#ham_step_size').val(settings.stepSize);
    $('#ham_retry_on_invalid').prop('checked', settings.retryOnInvalid);
    $('#ham_max_retries').val(settings.maxRetries);
    $('#ham_test_message').val(settings.testMessage);
    $('#ham_analysis_prompt').val(settings.analysisPrompt);
    $('#ham_use_patterns').prop('checked', settings.usePatternsFile);
    $('#ham_patterns_prompt').val(settings.patternsPrompt || defaultSettings.patternsPrompt);
    
    // Bind event handlers
    $('#ham_enabled').on('change', function() {
        extension_settings[extensionName].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_auto_connect').on('change', function() {
        extension_settings[extensionName].autoConnect = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_debug_mode').on('change', function() {
        extension_settings[extensionName].debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_intiface_address').on('input', function() {
        const addr = $(this).val().trim();
        extension_settings[extensionName].intifaceAddress = addr;
        IntifaceState.SERVER_ADDRESS = addr;
        saveSettingsDebounced();
    });
    
    $('#ham_min_speed').on('input', function() {
        extension_settings[extensionName].minSpeed = parseInt($(this).val()) || 32;
        saveSettingsDebounced();
    });
    
    $('#ham_max_speed').on('input', function() {
        extension_settings[extensionName].maxSpeed = parseInt($(this).val()) || 450;
        saveSettingsDebounced();
    });
    
    $('#ham_stroke_length').on('input', function() {
        extension_settings[extensionName].strokeLength = parseInt($(this).val()) || 125;
        saveSettingsDebounced();
    });
    
    $('#ham_expand_slow').on('change', function() {
        extension_settings[extensionName].expandSlowMovements = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_step_size').on('input', function() {
        extension_settings[extensionName].stepSize = parseFloat($(this).val()) || 1;
        saveSettingsDebounced();
    });
    
    $('#ham_retry_on_invalid').on('change', function() {
        extension_settings[extensionName].retryOnInvalid = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_max_retries').on('input', function() {
        extension_settings[extensionName].maxRetries = parseInt($(this).val()) || 3;
        saveSettingsDebounced();
    });
    
    $('#ham_test_message').on('input', function() {
        extension_settings[extensionName].testMessage = $(this).val();
        saveSettingsDebounced();
    });
    
    $('#ham_analysis_prompt').on('input', function() {
        extension_settings[extensionName].analysisPrompt = $(this).val();
        saveSettingsDebounced();
    });
    
    $('#ham_use_patterns').on('change', function() {
        extension_settings[extensionName].usePatternsFile = $(this).prop('checked');
        saveSettingsDebounced();
    });
    
    $('#ham_patterns_prompt').on('input', function() {
        extension_settings[extensionName].patternsPrompt = $(this).val();
        saveSettingsDebounced();
    });
    
    // Connection buttons
    $('#ham_connect_btn').on('click', function() {
        IntifaceState.SERVER_ADDRESS = settings.intifaceAddress;
        connectIntiface();
    });
    
    $('#ham_disconnect_btn').on('click', disconnectIntiface);
    
    $('#ham_stop_btn').on('click', function() {
        emergencyStop(); // [glide mod] hold in place instead of jumping to 0
    });
    
    // Reset prompt button
    $('#ham_reset_prompt_btn').on('click', function() {
        $('#ham_analysis_prompt').val(defaultSettings.analysisPrompt);
        extension_settings[extensionName].analysisPrompt = defaultSettings.analysisPrompt;
        saveSettingsDebounced();
    });
    
    // Reset patterns prompt button
    $('#ham_reset_patterns_prompt_btn').on('click', function() {
        $('#ham_patterns_prompt').val(defaultSettings.patternsPrompt);
        extension_settings[extensionName].patternsPrompt = defaultSettings.patternsPrompt;
        saveSettingsDebounced();
    });
    
    // Test LLM button
    $('#ham_test_llm_btn').on('click', async function() {
        const testMessage = $('#ham_test_message').val();
        if (!testMessage || testMessage.trim() === '') {
            toastr?.warning?.('Please enter a test message', 'Handy AI Motion');
            return;
        }
        
        toastr?.info?.('Running LLM analysis...', 'Handy AI Motion');
        
        const result = await analyzeMessageWithLLM(testMessage, []);
        
        if (result) {
            toastr?.success?.('Analysis complete, starting playback', 'Handy AI Motion');
            if (getConfig().glideMode && result.pace !== undefined) {
                Glide.setTarget(result); // [glide mod]
            } else {
                startPlayback(result);
            }
        } else {
            toastr?.error?.('Analysis failed', 'Handy AI Motion');
        }
    });
    
    // Custom JSON test
    $('#ham_custom_test_btn').on('click', function() {
        const jsonStr = $('#ham_custom_test_json').val();
        if (!jsonStr || jsonStr.trim() === '') {
            toastr?.warning?.('Please enter a JSON pattern', 'Handy AI Motion');
            return;
        }
        
        try {
            const data = JSON.parse(jsonStr);
            startPlayback(data);
        } catch (err) {
            toastr?.error?.(`Invalid JSON: ${err.message}`, 'Handy AI Motion');
        }
    });
    
    // Load example button
    $('#ham_load_example_btn').on('click', function() {
        const example = {
            start: ["1000,50"],
            loop: ["400,100", "400,0"]
        };
        $('#ham_custom_test_json').val(JSON.stringify(example, null, 2));
    });
    
    // Patterns file buttons
    $('#ham_open_patterns_btn').on('click', openPatternsFile);
    $('#ham_reload_patterns_btn').on('click', reloadPatterns);
    
    // Auto-connect if enabled
    if (settings.autoConnect) {
        IntifaceState.SERVER_ADDRESS = settings.intifaceAddress;
        setTimeout(connectIntiface, 1000);
    }
    
    // Register event listener for incoming messages
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_SENT, (messageId) => {
        const cfg = getConfig();
        // [glide mod] In glide mode the motion carries on while you chat. Your message can
        // stop it at once, call an edge, or set an edge goal.
        if (cfg.glideMode) {
            let text = '';
            try {
                const ctx = window.SillyTavern?.getContext();
                text = ctx?.chat?.[messageId]?.mes || '';
            } catch { /* ignore */ }

            const cooling = Date.now() < Glide.cooldownUntil;
            const moving = Glide.active && !Glide.stopping;

            // The user spoke: unprompted replies start counting from zero again
            if (Session.idleTimer) {
                clearTimeout(Session.idleTimer);
                Session.idleTimer = null;
            }
            Session.unprompted = 0;
            Session.queuedFollowUp = null;

            if ((Glide.active || cooling) && hasStopWord(text, cfg)) {
                emergencyStop();
                updateSessionNote();
                return;
            }
            Session.stopRequested = false;

            const goal = parseEdgeGoal(text);
            if (goal > 0) {
                Session.edgeGoal = goal;
                Session.edgeCount = 0;
                Session.lastEdgeAt = 0;
                toastr?.info?.(`Edge goal set to ${goal}`, 'Handy AI Motion');
            } else if (/\breset edges?\b/i.test(text)) {
                Session.edgeCount = 0;
                Session.edgeGoal = 0;
                Session.lastEdgeAt = 0;
            } else if (moving && isEdgeCall(text, cfg.edgeWords)) {
                countEdge();
                Session.edgePendingAck = true;
                Glide.edge(cfg);
            } else if (moving && isEdgeCall(text, cfg.closeWords)) {
                countEdge();
                Session.closePendingAck = true;
                Glide.backOff();
            }

            Glide.report();
            updateSessionNote();
            if (Glide.active || Date.now() < Glide.cooldownUntil) {
                return;
            }
        }
        // Stop playback when user sends a message
        stopPlayback();
    });

    // [glide mod] keep the session note current for regenerations and swipes too
    eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
        if (!dryRun) Session.generating = true;
        updateSessionNote();
    });

    // [glide mod] when a reply has finished, run any follow-up that was waiting for it
    const onGenerationDone = () => {
        Session.generating = false;
        if (Session.queuedFollowUp) {
            const reason = Session.queuedFollowUp;
            Session.queuedFollowUp = null;
            setTimeout(() => triggerFollowUp(reason), 1500);
        }
    };
    eventSource.on(event_types.GENERATION_ENDED, onGenerationDone);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationDone);

    // [glide mod] a different chat starts with a clean edge count
    eventSource.on(event_types.CHAT_CHANGED, () => {
        Session.edgeCount = 0;
        Session.edgeGoal = 0;
        Session.edgePendingAck = false;
        Session.closePendingAck = false;
        Session.lastEdgeAt = 0;
        Session.followUpReason = null;
        Session.queuedFollowUp = null;
        Session.awaitingFollowUp = false;
        Session.unprompted = 0;
        Session.stopRequested = false;
        clearFollowUpTimers();
        Glide.cancelCooldown();
        if (Glide.active) Glide.setTarget({ pace: 0 }); // leaving the chat eases the touch to a stop
        Glide.report();
        updateSessionNote();
    });
    
    console.log(`${LOG_PREFIX} Extension initialized`);
}

// Import event types and event source from SillyTavern
import { event_types, eventSource } from "../../../../script.js";

// Initialize when jQuery is ready
jQuery(async () => {
    await initExtension();
});
