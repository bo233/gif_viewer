import { decompressFrames, parseGIF } from 'gifuct-js';

// VS Code acquire api (declared at runtime)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const vscode = acquireVsCodeApi?.();

interface Frame {
  delay: number; // ms
  imageData: ImageData;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const prevBtn = document.getElementById('prev') as HTMLButtonElement;
const nextBtn = document.getElementById('next') as HTMLButtonElement;
const progress = document.getElementById('progress') as HTMLInputElement;
const speedSel = document.getElementById('speed') as HTMLSelectElement;
const infoEl = document.getElementById('info') as HTMLSpanElement;

let frames: Frame[] = [];
let current = 0;
let playing = false;
// 初始倍速（可由扩展配置注入）
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
let speed = (window.__initialPlaybackSpeed && !isNaN(window.__initialPlaybackSpeed)) ? Number(window.__initialPlaybackSpeed) : 1;
let rafHandle: number | null = null;
let lastTimestamp = 0;
let accumulated = 0; // ms
let totalDuration = 0;
const MAX_FRAMES_WARNING = 2000;
let logicalW = 0;
let logicalH = 0;

function setInfo(text: string){
  infoEl.textContent = text;
}

function arrayBufferFromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const buf = new Uint8Array(len);
  for (let i=0;i<len;i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function decode(base64: string){
  try {
    setInfo('解析中...');
    const ab = arrayBufferFromBase64(base64);
    const gif = parseGIF(ab);
    const rawFrames = decompressFrames(gif, true);
    if(!rawFrames.length){
      setInfo('无有效帧');
      frames = [];
      return;
    }
    // 逻辑画布尺寸（GIF 全尺寸）
  logicalW = (gif as any).lsd?.width || rawFrames[0].dims.width;
  logicalH = (gif as any).lsd?.height || rawFrames[0].dims.height;

  // 全尺寸合成：逐帧叠加 patch，处理 disposalType 0/1/2/3
    const composed: Frame[] = [];
  let baseForNext = new Uint8ClampedArray(logicalW * logicalH * 4); // 当前基底（下一帧开始前的画布）
  let previousFrameSnapshot: Uint8ClampedArray | null = null; // 给 disposal=3 使用

    for(let i=0;i<rawFrames.length;i++){
      const rf = rawFrames[i];
      const disposal = rf.disposalType; // 0/1=不处理,2=恢复背景,3=恢复到前一状态

      // disposal=3 需要在绘制前快照
      if(disposal === 3){
        previousFrameSnapshot = new Uint8ClampedArray(baseForNext); // 保存当前基底
      } else {
        previousFrameSnapshot = null;
      }

      // 基于当前基底复制，用于本帧合成
      const currentFull = new Uint8ClampedArray(baseForNext);
      const { left, top, width: fw, height: fh } = rf.dims;
      const patch = rf.patch as Uint8ClampedArray;
      // 写入 patch：若 alpha=0 跳过以保留底层
      for(let y=0;y<fh;y++){
        for(let x=0;x<fw;x++){
          const si = (y*fw + x)*4;
          const alpha = patch[si+3];
          if(alpha === 0) continue; // 跳过完全透明像素
          const di = ((top + y)*logicalW + (left + x))*4;
          currentFull[di] = patch[si];
          currentFull[di+1] = patch[si+1];
          currentFull[di+2] = patch[si+2];
          currentFull[di+3] = alpha;
        }
      }

      // 输出帧
      const imageData = new ImageData(currentFull, logicalW, logicalH);
      composed.push({ delay: Math.max(10, rf.delay || 0), imageData });

      // 准备下一帧基底
      switch(disposal){
        case 2: { // 恢复背景：先基于 currentFull，再清该区域
          const nextBase = new Uint8ClampedArray(currentFull);
          for(let y=0;y<fh;y++){
            for(let x=0;x<fw;x++){
              const di = ((top + y)*logicalW + (left + x))*4;
              nextBase[di] = 0;
              nextBase[di+1] = 0;
              nextBase[di+2] = 0;
              nextBase[di+3] = 0;
            }
          }
          baseForNext = nextBase;
          break; }
        case 3: { // 恢复到前一状态
          if(previousFrameSnapshot){
            baseForNext = new Uint8ClampedArray(previousFrameSnapshot);
          } else {
            baseForNext = new Uint8ClampedArray(currentFull); // 回退失败就当作不处理
          }
          break; }
        case 0:
        case 1:
        default:
          baseForNext = new Uint8ClampedArray(currentFull);
      }
    }

    frames = composed;
    totalDuration = frames.reduce((a,f)=>a+f.delay,0);
    progress.max = String(frames.length - 1);
    // resize canvas
  canvas.width = frames[0].imageData.width;
  canvas.height = frames[0].imageData.height;
  recalcScale();
    current = 0;
    drawFrame();
    let extra = '';
    if(frames.length > MAX_FRAMES_WARNING){
      extra = ' ⚠大量帧, 性能可能下降';
    }
    setInfo(`${frames.length} 帧 / ${(totalDuration/1000).toFixed(2)}s${extra}`);
    // 默认自动播放
    if(!playing){
      play();
    }
  } catch (e){
    console.error(e);
    setInfo('解析失败');
  }
}

function drawFrame(){
  if(!frames.length) return;
  const fr = frames[current];
  ctx.putImageData(fr.imageData,0,0);
  progress.value = String(current);
}

function recalcScale(){
  if(!logicalW || !logicalH) return;
  const parent = canvas.parentElement as HTMLElement;
  if(!parent) return;
  const pw = parent.clientWidth;
  const ph = parent.clientHeight;
  if(pw<=0 || ph<=0) return;
  const scale = Math.min(pw / logicalW, ph / logicalH);
  const displayW = Math.max(1, Math.floor(logicalW * scale));
  const displayH = Math.max(1, Math.floor(logicalH * scale));
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';
}

const resizeObserver = new ResizeObserver(recalcScale);
if(canvas.parentElement){
  resizeObserver.observe(canvas.parentElement);
}

function stepPlay(timestamp: number){
  if(!playing) return;
  if(!lastTimestamp) lastTimestamp = timestamp;
  const delta = timestamp - lastTimestamp;
  lastTimestamp = timestamp;
  accumulated += delta * speed;
  let loops = 0;
  while(accumulated >= frames[current].delay){
    accumulated -= frames[current].delay;
    current = (current + 1) % frames.length;
    loops++;
    if(loops>10) break; // avoid long blocking
  }
  drawFrame();
  if(playing) rafHandle = requestAnimationFrame(stepPlay);
}

function play(){
  if(!frames.length){return;}
  playing = true;
  playBtn.textContent = '⏸';
  lastTimestamp = 0;
  accumulated = 0;
  rafHandle = requestAnimationFrame(stepPlay);
}
function pause(){
  playing = false;
  playBtn.textContent = '▶';
  if(rafHandle) cancelAnimationFrame(rafHandle);
}

playBtn.addEventListener('click', ()=>{
  playing ? pause() : play();
});
prevBtn.addEventListener('click', ()=>{
  pause();
  if(frames.length){
    current = (current - 1 + frames.length) % frames.length;
    drawFrame();
  }
});
nextBtn.addEventListener('click', ()=>{
  pause();
  if(frames.length){
    current = (current + 1) % frames.length;
    drawFrame();
  }
});
progress.addEventListener('input', ()=>{
  pause();
  current = Number(progress.value);
  drawFrame();
});

speedSel.addEventListener('change', ()=>{
  const v = Number(speedSel.value);
  if(v < 0.1) speed = 0.1; else if(v>4) speed = 4; else speed = v;
});

window.addEventListener('message', (event)=>{
  const msg = event.data;
  if(msg.type === 'reload'){
    decode(msg.data);
  } else if(msg.type === 'copyResult'){
    if(!msg.ok){
      setInfo('复制失败');
      console.error(msg.message);
    }
  }
});

// 键盘快捷键：窗口聚焦时生效
window.addEventListener('keydown', (e)=>{
  // 避免在可编辑/输入元素中触发（当前无输入，但保留健壮性）
  const tag = (e.target as HTMLElement)?.tagName;
  if(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable){
    return;
  }
  if(e.code === 'Space'){
    e.preventDefault();
    playing ? pause() : play();
  } else if(e.code === 'ArrowLeft'){
    e.preventDefault();
    pause();
    if(frames.length){
      current = (current - 1 + frames.length) % frames.length;
      drawFrame();
    }
  } else if(e.code === 'ArrowRight'){
    e.preventDefault();
    pause();
    if(frames.length){
      current = (current + 1) % frames.length;
      drawFrame();
    }
  } else if(e.code === 'ArrowUp'){
    e.preventDefault();
    // 预设速度列表（按下一个档位提升）
    const opts = Array.from(speedSel.options).map(o=>Number(o.value)).sort((a,b)=>a-b);
    const currentIdx = opts.findIndex(v=>v >= speed);
    let target: number;
    if(currentIdx === -1){
      target = opts[0];
    } else {
      // 如果当前正好是某个档位，就取下一个；否则取当前Idx对应档位
      if(opts[currentIdx] === speed){
        target = opts[Math.min(opts.length-1, currentIdx+1)];
      } else {
        target = opts[currentIdx];
      }
    }
    speed = target;
    // 同步下拉选中（若存在对应值）
    const match = Array.from(speedSel.options).find(o=>Number(o.value)===speed);
    if(match) speedSel.value = String(speed);
  } else if(e.code === 'ArrowDown'){
    e.preventDefault();
    const opts = Array.from(speedSel.options).map(o=>Number(o.value)).sort((a,b)=>a-b);
    const currentIdx = opts.findIndex(v=>v >= speed);
    let target: number;
    if(currentIdx === -1){
      target = opts[0];
    } else {
      if(opts[currentIdx] === speed){
        target = opts[Math.max(0, currentIdx-1)];
      } else {
        // speed 介于两个档之间，降低到前一个档位
        target = opts[Math.max(0, currentIdx-1)];
      }
    }
    speed = target;
    const match = Array.from(speedSel.options).find(o=>Number(o.value)===speed);
    if(match) speedSel.value = String(speed);
  } else if((e.metaKey || e.ctrlKey) && e.code === 'KeyC'){
    // 复制 GIF 原始文件路径
    vscode?.postMessage({ type: 'copyGif' });
  }
});

// 初始加载
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if(window.__initialGifBase64){
  // @ts-ignore
  decode(window.__initialGifBase64);
} else {
  vscode?.postMessage({ type: 'requestBytes' });
}

// 同步下拉框显示初始倍速（若匹配某个 option）
const matchInit = Array.from(speedSel.options).find(o=>Number(o.value)===speed);
if(matchInit){
  speedSel.value = String(speed);
}

// 大文件提示
// @ts-ignore
if(window.__isLargeGif){
  setInfo((infoEl.textContent ? infoEl.textContent + ' ' : '') + '⚠ 文件较大，解析可能耗时');
}
