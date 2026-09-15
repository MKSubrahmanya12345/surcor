/**
 * Everflow — the bundled documentation corpus.
 *
 * The agent's research tool consults, in order: the component catalog (live
 * ground truth), this corpus (authored platform/library facts with citations),
 * and optionally the live web (flagged for human review). The corpus is what
 * makes the tool work offline and deterministically — every entry carries a
 * source the user can open.
 */

export interface CorpusEntry {
  id: string;
  topic: string;
  /** Words that indicate this entry answers a question. */
  keywords: string[];
  /** Verified facts, written as they would be cited. */
  facts: string[];
  source: { label: string; url: string };
}

export const DOCS_CORPUS: CorpusEntry[] = [
  {
    id: 'raspberry-pi-5',
    topic: 'Raspberry Pi 5 (single-board computer)',
    keywords: ['raspberry pi', 'rasp pi', 'pi 5', 'pi5', 'raspberry', 'sbc'],
    facts: [
      'Raspberry Pi 5: quad-core Cortex-A76 at 2.4 GHz, 4/8/16 GB LPDDR4X RAM, 40-pin GPIO header (3.3 V logic).',
      'Powered over USB-C (5 V, up to 5 A); GPIO pins source/sink 16 mA max (4 mA recommended per pin).',
      'Runs a full Linux OS (Raspberry Pi OS) — software is Python (or any language), not Arduino sketches.',
      'Has one CSI camera port, 2× USB 3, GbE, HDMI; Wi-Fi via on-board module or USB dongle on older boards.',
    ],
    source: { label: 'Raspberry Pi — official documentation', url: 'https://www.raspberrypi.com/documentation/computers/raspberry-pi.html' },
  },
  {
    id: 'raspberry-pi-cameras',
    topic: 'Cameras on a Raspberry Pi (CSI vs USB)',
    keywords: ['csi', 'pi camera', 'camera module', 'multiple cameras', 'usb webcam', 'webcam', 'cameras'],
    facts: [
      'CSI cameras attach by ribbon cable to the camera port — no wiring, no power pins; the Pi powers them.',
      'Pi 5 supports TWO CSI cameras natively; Pi 4/3 support one CSI camera (a second needs an I2C mux or USB).',
      'USB webcams are UVC class: they need only a USB connection, appear as /dev/video0, /dev/video1, …',
      'For more than two cameras, USB webcams or a USB hub are the practical route.',
    ],
    source: { label: 'Raspberry Pi — cameras documentation', url: 'https://www.raspberrypi.com/documentation/computers/camera.html' },
  },
  {
    id: 'opencv-python',
    topic: 'OpenCV for Python (video capture + detection)',
    keywords: ['opencv', 'open cv', 'video capture', 'cv2', 'detection', ' haar', 'haarcascade', 'dnn'],
    facts: [
      'OpenCV 4.x for Python: `pip install opencv-python` (use `opencv-python-headless` on servers without a display).',
      'cv2.VideoCapture(index) opens camera N — index 0 for the first/CSI camera, 1 for the second, and so on.',
      'Face detection ships two practical routes: Haar cascades (fast, classical) and the DNN module with a trained face model (more robust to lighting).',
      'Real-time single-stream detection runs comfortably on a Pi 5; expect a lower frame rate on Pi 4/3.',
    ],
    source: { label: 'OpenCV documentation', url: 'https://docs.opencv.org/4.x/d6/0af/tutorial_py_table_of_contents.html' },
  },
  {
    id: 'face-recognition-pipeline',
    topic: 'Face registration and recognition pipeline',
    keywords: ['face', 'faces', 'recognise', 'recognize', 'recognition', 'registered', 'register', 'enrollment', 'identity', 'unknown face'],
    facts: [
      'A working face-security system has three stages: DETECT (find a face), EMBED (convert it to a fixed-size vector), MATCH (compare against registered vectors).',
      'Store EMBEDDINGS (vectors) in the database, not raw photos — matching is a fast vector comparison and it is privacy-better.',
      'OpenCV DNN models (e.g. YuNet for detection + SFace/recognition embeddings) are the lightest modern route on a Pi.',
      'Matching uses a distance threshold: below the threshold the face is "registered", above it "unknown" — the threshold is the false-alarm dial.',
      'Multiple cameras = one detection/embedding worker per stream writing into the same registry and event log.',
    ],
    source: { label: 'OpenCV DNN face models + RPi camera docs', url: 'https://docs.opencv.org/4.x/da/d54/group__dnn.html' },
  },
  {
    id: 'web-registry-service',
    topic: 'A web app for registering faces',
    keywords: ['website', 'web app', 'webapp', 'dashboard', 'register', 'portal', 'web server', 'http', 'api'],
    facts: [
      'A registration web app = a web server (FastAPI/Flask in Python) that accepts a photo, runs it through the same embedding pipeline, and stores the vector with a label.',
      'Keep the capture path on the Pi (or any worker) and only expose a small HTTP API — the web tier stays thin.',
      'Every recognition event (known/unknown, camera, timestamp, embedding distance) belongs in a log the site can query.',
      'Put the site behind a password at minimum; face data is personal data — state who can register and who can view events.',
    ],
    source: { label: 'FastAPI documentation', url: 'https://fastapi.tiangolo.com/' },
  },
  {
    id: 'esp32-devkit',
    topic: 'ESP32 (MCU with Wi-Fi/BLE)',
    keywords: ['esp32', 'esp-32', 'esp32 devkit'],
    facts: [
      'ESP32 DevKit: dual-core 240 MHz MCU, 3.3 V logic, Wi-Fi + BLE, ~30 usable GPIO; GPIO6-11 are flash — never use them.',
      'Powered over USB 5 V; radio bursts need ~500 mA headroom on the 3.3 V rail.',
    ],
    source: { label: 'Espressif — ESP32 documentation', url: 'https://docs.espressif.com/projects/esp-idf/en/latest/esp32/' },
  },
  {
    id: 'arduino-uno',
    topic: 'Arduino UNO (AVR MCU)',
    keywords: ['arduino uno', 'uno r3', 'arduino'],
    facts: [
      'Arduino UNO: ATmega328P at 16 MHz, 5 V logic, 14 digital I/O (6 PWM), 6 analog inputs, I2C on A4/A5 (hard-wired), SPI on 10-13.',
      'Pin max current 40 mA, board current 500 mA; powered over USB 5 V or VIN 7-12 V.',
    ],
    source: { label: 'Arduino — official reference', url: 'https://docs.arduino.cc/hardware/uno-rev3' },
  },
  {
    id: 'ultrasonic-hc-sr04',
    topic: 'HC-SR04 ultrasonic distance sensor',
    keywords: ['hc-sr04', 'hc sr04', 'ultrasonic', 'sonar', 'distance sensor'],
    facts: [
      'HC-SR04: 5 V, TRIG/ECHO digital pins, measures 2 cm–4 m; ECHO pulse width ÷ 58 µs = distance in cm.',
      'Drive TRIG with a ≥10 µs pulse; keep wires short or the echo distorts.',
    ],
    source: { label: 'HC-SR04 datasheet (common rev. summary)', url: 'https://www.sparkfun.com/datasheets/Sensors/General/hcrs04.pdf' },
  },
  {
    id: 'l298n-motor-driver',
    topic: 'L298N dual H-bridge motor driver',
    keywords: ['l298n', 'l298', 'motor driver', 'h-bridge'],
    facts: [
      'L298N: dual H-bridge, drives two DC motors (or one bipolar stepper) at up to 2 A each; logic side 5 V, motor supply 5-35 V.',
      'Runs hot — assume a heatsink; keep motor supply separated from the 5 V rail the logic uses.',
    ],
    source: { label: 'L298N datasheet (ST, summary)', url: 'https://www.st.com/resource/en/datasheet/l298n.pdf' },
  },
];
