import {
  AmbientLight, Box3, BufferGeometry, Color, DirectionalLight, DoubleSide, Group, LoadingManager,
  Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Points, PointsMaterial, Scene, Texture, TextureLoader, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

type PreviewData = {
  data: string; name: string; extension: string;
  theme: { foreground: string; background: string; line: string; accent: string; dark: boolean };
};

function bytes(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

function embeddedURI(uri: string): ArrayBuffer {
  const match = /^data:[^,]*?(;base64)?,([\s\S]*)$/i.exec(uri);
  if (!match) throw new Error('模型引用了外部资源，请使用内嵌资源的 GLB 或 GLTF');
  return match[1] ? bytes(match[2]).buffer : new TextEncoder().encode(decodeURIComponent(match[2])).buffer;
}

async function model(payload: PreviewData): Promise<Object3D> {
  const binary = bytes(payload.data);
  payload.data = '';
  const extension = payload.extension.toLowerCase().replace(/^\./, '');
  const material = (geometry: BufferGeometry) => new MeshStandardMaterial({
    color: geometry.hasAttribute('color') ? 0xffffff : payload.theme.accent,
    vertexColors: geometry.hasAttribute('color'), side: DoubleSide, roughness: 0.7, metalness: 0.05,
  });
  if (extension === 'obj') return new OBJLoader().parse(new TextDecoder().decode(binary));
  if (extension === 'stl') {
    const geometry = new STLLoader().parse(binary.buffer);
    return new Mesh(geometry, material(geometry));
  }
  if (extension === 'ply') {
    const geometry = new PLYLoader().parse(binary.buffer);
    if (geometry.index == null) return new Points(geometry, new PointsMaterial({
      color: geometry.hasAttribute('color') ? 0xffffff : payload.theme.accent,
      vertexColors: geometry.hasAttribute('color'), size: 0.01, sizeAttenuation: true,
    }));
    if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
    return new Mesh(geometry, material(geometry));
  }
  if (extension !== 'glb' && extension !== 'gltf') throw new Error('模型格式暂不支持');
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (/^(?:data:|blob:)/i.test(url)) return url;
    throw new Error('模型引用了外部资源，请使用内嵌资源的 GLB 或 GLTF');
  });
  const loader = new GLTFLoader(manager);
  loader.register(parser => {
    const buffers = (parser.json.buffers ?? []) as { uri?: string; byteLength: number }[];
    const images = (parser.json.images ?? []) as { uri?: string }[];
    for (const resource of [...buffers, ...images]) {
      if (resource.uri != null && !resource.uri.startsWith('data:')) throw new Error('模型引用了外部资源，请使用内嵌资源的 GLB 或 GLTF');
    }
    // ImageBitmapLoader uses fetch even for embedded images. TextureLoader uses <img>, which
    // works under img-src data: blob: while connect-src remains completely disabled.
    parser.textureLoader = new TextureLoader(manager);
    const decodedBuffers = new Map<number, ArrayBuffer>();
    return {
      name: 'RIFFET_embedded_resources',
      loadBufferView(index) {
        const definition = parser.json.bufferViews[index] as { buffer: number; byteOffset?: number; byteLength: number };
        const buffer = buffers[definition.buffer];
        if (buffer?.uri == null) return null; // GLB's binary chunk is already in memory.
        let data = decodedBuffers.get(definition.buffer);
        if (!data) {
          data = embeddedURI(buffer.uri);
          if (data.byteLength < buffer.byteLength) return Promise.reject(new Error('模型内嵌缓冲区不完整'));
          decodedBuffers.set(definition.buffer, data);
        }
        const offset = definition.byteOffset ?? 0;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(definition.byteLength) || offset < 0 || definition.byteLength < 0 || offset + definition.byteLength > data.byteLength) return Promise.reject(new Error('模型缓冲区越界'));
        return Promise.resolve(data.slice(offset, offset + definition.byteLength));
      },
    };
  });
  const parsed = await loader.parseAsync(extension === 'gltf' ? new TextDecoder().decode(binary) : binary.buffer, '');
  return parsed.scene;
}

async function main() {
  const input = document.getElementById('riffet-preview-data');
  if (!input?.textContent) throw new Error('缺少模型内容');
  const payload = JSON.parse(input.textContent) as PreviewData;
  input.remove();
  document.body.style.cssText = 'margin:0;width:100%;height:100vh;overflow:hidden';
  document.body.style.background = payload.theme.background;
  document.body.style.color = payload.theme.foreground;
  const host = document.getElementById('preview') ?? document.createElement('main');
  host.id = 'model-preview'; host.style.cssText = 'width:100%;height:100%;min-height:240px;position:relative';
  if (!host.isConnected) document.body.append(host);
  const object = await model(payload);
  let vertices = 0;
  object.traverse(child => {
    const mesh = child as Mesh;
    if (!mesh.geometry) return;
    vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
  });
  if (vertices === 0) throw new Error('模型中没有可显示的几何体');
  if (vertices > 3_000_000) throw new Error('模型过大，请下载后打开');
  const bounds = new Box3().setFromObject(object);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (![...center.toArray(), ...size.toArray(), extent].every(Number.isFinite) || extent <= 0) throw new Error('模型尺寸无效');
  const container = new Group();
  object.position.sub(center);
  container.add(object); container.scale.setScalar(2 / extent);
  const scene = new Scene();
  scene.background = new Color(payload.theme.background); scene.add(container);
  scene.add(new AmbientLight(0xffffff, 2));
  const key = new DirectionalLight(0xffffff, 3); key.position.set(4, 6, 5); scene.add(key);
  const fill = new DirectionalLight(0xffffff, 1); fill.position.set(-4, 1, -3); scene.add(fill);
  const camera = new PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.set(2.8, 1.8, 3.2);
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.domElement.setAttribute('aria-label', payload.name);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  host.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 0.2; controls.maxDistance = 30; controls.enableDamping = false;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);
  const resize = () => {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    const ratio = Math.min(devicePixelRatio || 1, 2, 4096 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
    renderer.setPixelRatio(ratio); renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix(); controls.update(); render();
  };
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); failure('图形上下文已丢失，请重新打开预览'); });
  addEventListener('pagehide', () => {
    observer.disconnect(); controls.dispose(); renderer.dispose();
    object.traverse(child => {
      const mesh = child as Mesh;
      mesh.geometry?.dispose();
      const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      for (const material of materials) {
        for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
        material.dispose();
      }
    });
  }, { once: true });
}

function failure(message: string) {
  const node = document.createElement('p');
  node.textContent = message; node.style.cssText = 'padding:16px;font:14px system-ui';
  document.getElementById('model-preview')?.remove(); document.body.append(node);
}

void main().catch(error => failure(error instanceof Error ? `模型预览失败：${error.message}` : '模型预览失败'));
