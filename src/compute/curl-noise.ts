import * as THREE from "three/webgpu"

// Ported verbatim from threely. This is opaque WGSL wrapped in TSL wgslFn()
// calls; @types/three types the dependency-array form far more strictly than
// the runtime accepts, and the shader source is the real contract here, so the
// wgslFn binding is deliberately untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wgslFn: any = THREE.TSL.wgslFn

const noise_permute_f32 = wgslFn(`
fn noise_permute_f32(x: f32) -> f32 {
    return (((x * 34.0) + 10.0) * x) % 289.0;
}
`)

const noise_permute_vec4f = wgslFn(`

fn noise_permute_vec4f(x: vec4<f32>) -> vec4<f32> {
    return (((x * 34.0) + 10.0) * x) % 289.0;
}
`)

const noise_simplex_vec4f_gradient = wgslFn(`

fn noise_simplex_vec4f_gradient(j: f32, ip: vec4<f32>) -> vec4<f32> {
    let ones = vec4(1.0, 1.0, 1.0, -1.0);
    var p: vec4<f32>;
    var s: vec4<f32>;

    let sw0 = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
    p.x = sw0.x;
    p.y = sw0.y;
    p.z = sw0.z;

    p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
    s = vec4<f32>(p < vec4(0.0));

    let sw1 = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
    p.x = sw1.x;
    p.y = sw1.y;
    p.z = sw1.z;

    return p;
}
`)

// from https://github.com/bevy-interstellar/wgsl_noise/blob/main/common.wgsl


const noise_simplex_vec4f = wgslFn(`


fn noise_simplex_vec4f(v: vec4<f32>) -> f32 {
    let c = vec4(
        0.138196601125011,  // (5 - sqrt(5))/20  G4
        0.276393202250021,  // 2 * G4
        0.414589803375032,  // 3 * G4
        -0.447213595499958  // -1 + 4 * G4
    );

    // (sqrt(5) - 1)/4 = F4, used once below
    let f4 = 0.309016994374947451;

    // First corner
    var i = floor(v + dot(v, vec4(f4)));
    let x0 = v - i + dot(i, c.xxxx);

    // Other corners

    // Rank sorting originally contributed by Bill Licea-Kane, AMD (formerly ATI)
    var i0: vec4<f32>;
    let isX = step(x0.yzw, x0.xxx);
    let isYZ = step(x0.zww, x0.yyz);
    //  i0.x = dot( isX, vec3( 1.0 ) );
    i0.x = isX.x + isX.y + isX.z;
    i0.y = 1.0 - isX.x;
    i0.z = 1.0 - isX.y;
    i0.w = 1.0 - isX.z;
    //  i0.y += dot( isYZ.xy, vec2( 1.0 ) );
    i0.y += isYZ.x + isYZ.y;
    i0.z += 1.0 - isYZ.x;
    i0.w += 1.0 - isYZ.y;
    i0.z += isYZ.z;
    i0.w += 1.0 - isYZ.z;

    // i0 now contains the unique values 0,1,2,3 in each channel
    let i3 = clamp(i0, vec4(0.0), vec4(1.0));
    let i2 = clamp(i0 - 1.0, vec4(0.0), vec4(1.0));
    let i1 = clamp(i0 - 2.0, vec4(0.0), vec4(1.0));

    // x0 = x0 - 0.0 + 0.0 * C.xxxx
    // x1 = x0 - i1  + 1.0 * C.xxxx
    // x2 = x0 - i2  + 2.0 * C.xxxx
    // x3 = x0 - i3  + 3.0 * C.xxxx
    // x4 = x0 - 1.0 + 4.0 * C.xxxx
    let x1 = x0 - i1 + c.xxxx;
    let x2 = x0 - i2 + c.yyyy;
    let x3 = x0 - i3 + c.zzzz;
    let x4 = x0 + c.wwww;

    // Permutations
    i = i % 289.0;
    let j0 = noise_permute_f32(
        noise_permute_f32(
            noise_permute_f32(
                noise_permute_f32(i.w) + i.z
            ) + i.y
        ) + i.x
    );
    let j1 = noise_permute_vec4f(
        noise_permute_vec4f(
            noise_permute_vec4f(
                noise_permute_vec4f(
                    i.w + vec4(i1.w, i2.w, i3.w, 1.0)
                ) + i.z + vec4(i1.z, i2.z, i3.z, 1.0)
            ) + i.y + vec4(i1.y, i2.y, i3.y, 1.0)
        ) + i.x + vec4(i1.x, i2.x, i3.x, 1.0)
    );

    // Gradients: 7x7x6 points over a cube, mapped onto a 4-cross polytope
    // 7*7*6 = 294, which is close to the ring size 17*17 = 289.
    let ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0) ;

    var p0 = noise_simplex_vec4f_gradient(j0, ip);
    var p1 = noise_simplex_vec4f_gradient(j1.x, ip);
    var p2 = noise_simplex_vec4f_gradient(j1.y, ip);
    var p3 = noise_simplex_vec4f_gradient(j1.z, ip);
    var p4 = noise_simplex_vec4f_gradient(j1.w, ip);

    // Normalise gradients
    let norm = inverseSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;
    p4 *= inverseSqrt(dot(p4, p4));

    // Mix contributions from the five corners
    var m0 = max(
        0.6 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)),
        vec3(0.0)
    );
    var m1 = max(
        0.6 - vec2(dot(x3, x3), dot(x4, x4)),
        vec2(0.0)
    );
    m0 = m0 * m0;
    m1 = m1 * m1;
    return 49.0 * (dot(m0 * m0, vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2))) + dot(m1 * m1, vec2(dot(p3, x3), dot(p4, x4)))) ;
}
`, [
    noise_permute_f32,
    noise_permute_vec4f,
    noise_simplex_vec4f_gradient
]);

const mod289v4f = wgslFn(`
fn mod289v4f(i: vec4<f32>) -> vec4<f32> {
	return 
}
`)
const permute289v4f = wgslFn(`
fn permute289v4f(i: vec4<f32>) -> vec4<f32>
{
	var im: vec4<f32> = i - floor(i / 289.0) * 289.0;
	var i2 = (im*34.0 + 10.0)*im;
	return i2 - floor(i2 / 289.0) * 289.0;
;
}
`)

const psrdnoise3 = wgslFn(`
fn psrdnoise3(x: vec3<f32>, p: vec3<f32>, alpha: f32) -> NG3
{
	let M = mat3x3<f32>(0.0, 1.0, 1.0, 1.0, 0.0, 1.0,  1.0, 1.0, 0.0);
	let Mi = mat3x3<f32>(-0.5, 0.5, 0.5, 0.5,-0.5, 0.5, 0.5, 0.5,-0.5);

	var uvw: vec3<f32>;
	var i0: vec3<f32>;
	var i1: vec3<f32>;
	var i2: vec3<f32>;
	var i3: vec3<f32>;
	var f0: vec3<f32>;
	var gt_: vec3<f32>;
	var lt_: vec3<f32>;
	var gt: vec3<f32>;
	var lt: vec3<f32>;
	var o1: vec3<f32>;
	var o2: vec3<f32>;
	var v0: vec3<f32>;
	var v1: vec3<f32>;
	var v2: vec3<f32>;
	var v3: vec3<f32>;
	var x0: vec3<f32>;
	var x1: vec3<f32>;
	var x2: vec3<f32>;
	var x3: vec3<f32>;
	
	uvw = M * x;
	i0 = floor(uvw);
	f0 = uvw - i0;
	gt_ = step(f0.xyx, f0.yzz);
	lt_ = 1.0 - gt_;
	gt = vec3<f32>(lt_.z, gt_.xy);
	lt = vec3<f32>(lt_.xy, gt_.z);
	o1 = min( gt, lt );
	o2 = max( gt, lt );
	i1 = i0 + o1;
	i2 = i0 + o2;
	i3 = i0 + vec3<f32>(1.0,1.0,1.0);
	v0 = Mi * i0;
	v1 = Mi * i1;
	v2 = Mi * i2;
	v3 = Mi * i3;
	x0 = x - v0;
	x1 = x - v1;
	x2 = x - v2;
	x3 = x - v3;
	
	var vx: vec4<f32>;
	var vy: vec4<f32>;
	var vz: vec4<f32>;

	if(any(p > vec3<f32>(0.0))) {
		vx = vec4<f32>(v0.x, v1.x, v2.x, v3.x);
		vy = vec4<f32>(v0.y, v1.y, v2.y, v3.y);
		vz = vec4<f32>(v0.z, v1.z, v2.z, v3.z);
		if(p.x > 0.0) {
			vx = vx - floor(vx / p.x) * p.x;
		}
		if(p.y > 0.0) {
			vy = vy - floor(vy / p.y) * p.y;
		}
		if(p.z > 0.0) {
			vz = vz - floor(vz / p.z) * p.z;
		}
		i0 = floor(M * vec3<f32>(vx.x, vy.x, vz.x) + 0.5);
		i1 = floor(M * vec3<f32>(vx.y, vy.y, vz.y) + 0.5);
		i2 = floor(M * vec3<f32>(vx.z, vy.z, vz.z) + 0.5);
		i3 = floor(M * vec3<f32>(vx.w, vy.w, vz.w) + 0.5);
	}
	
	var hash: vec4<f32>;
	var theta: vec4<f32>;
	var sz: vec4<f32>;
	var psi: vec4<f32>;
	var St: vec4<f32>;
	var Ct: vec4<f32>;
	var sz_: vec4<f32>;

	hash = permute289v4f( permute289v4f( permute289v4f( 
		vec4<f32>(i0.z, i1.z, i2.z, i3.z ))
		+ vec4<f32>(i0.y, i1.y, i2.y, i3.y ))
		+ vec4<f32>(i0.x, i1.x, i2.x, i3.x ));
	theta = hash * 3.883222077;
	sz = hash * -0.006920415 + 0.996539792;
	psi = hash * 0.108705628;
	Ct = cos(theta);
	St = sin(theta);
	sz_ = sqrt( 1.0 - sz*sz );

	var gx: vec4<f32>;
	var gy: vec4<f32>;
	var gz: vec4<f32>;
	var px: vec4<f32>;
	var py: vec4<f32>;
	var pz: vec4<f32>;
	var Sp: vec4<f32>;
	var Cp: vec4<f32>;
	var Ctp: vec4<f32>;
	var qx: vec4<f32>;
	var qy: vec4<f32>;
	var qz: vec4<f32>;
	var Sa: vec4<f32>;
	var Ca: vec4<f32>;

	if(alpha != 0.0)
	{
		px = Ct * sz_;
		py = St * sz_;
		pz = sz;
		Sp = sin(psi);
		Cp = cos(psi);
		Ctp = St*Sp - Ct*Cp;
		qx = mix( Ctp*St, Sp, sz);
		qy = mix(-Ctp*Ct, Cp, sz);
		qz = -(py*Cp + px*Sp);
		Sa = vec4<f32>(sin(alpha));
		Ca = vec4<f32>(cos(alpha));
		gx = Ca*px + Sa*qx;
		gy = Ca*py + Sa*qy;
		gz = Ca*pz + Sa*qz;
	}
	else
	{
		gx = Ct * sz_;
		gy = St * sz_;
		gz = sz;  
	}
	
	var g0: vec3<f32>;
	var g1: vec3<f32>;
	var g2: vec3<f32>;
	var g3: vec3<f32>;
	var w: vec4<f32>;
	var w2: vec4<f32>;
	var w3: vec4<f32>;
	var gdotx: vec4<f32>;
	var n: f32;
	
	g0 = vec3<f32>(gx.x, gy.x, gz.x);
	g1 = vec3<f32>(gx.y, gy.y, gz.y);
	g2 = vec3<f32>(gx.z, gy.z, gz.z);
	g3 = vec3<f32>(gx.w, gy.w, gz.w);
	w = 0.5 - vec4<f32>(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3));
	w = max(w, vec4<f32>(0.0, 0.0, 0.0, 0.0));
	w2 = w * w;
	w3 = w2 * w;
	gdotx = vec4<f32>(dot(g0,x0), dot(g1,x1), dot(g2,x2), dot(g3,x3));
	n = 39.5 * dot(w3, gdotx);

	var dw: vec4<f32> = -6.0 * w2 * gdotx;
	var dn0: vec3<f32> = w3.x * g0 + dw.x * x0;
	var dn1: vec3<f32> = w3.y * g1 + dw.y * x1;
	var dn2: vec3<f32> = w3.z * g2 + dw.z * x2;
	var dn3: vec3<f32> = w3.w * g3 + dw.w * x3;
	var g: vec3<f32> = 39.5 * (dn0 + dn1 + dn2 + dn3);
	
	return g;
}
`, [permute289v4f])

const srdnoise3 = wgslFn(`
fn srdnoise3(x: vec3<f32>, alpha: f32) -> vec3<f32>
{
	let M = mat3x3<f32>(0.0, 1.0, 1.0, 1.0, 0.0, 1.0,  1.0, 1.0, 0.0);
	let Mi = mat3x3<f32>(-0.5, 0.5, 0.5, 0.5,-0.5, 0.5, 0.5, 0.5,-0.5);

	var uvw: vec3<f32>;
	var i0: vec3<f32>;
	var i1: vec3<f32>;
	var i2: vec3<f32>;
	var i3: vec3<f32>;
	var f0: vec3<f32>;
	var gt_: vec3<f32>;
	var lt_: vec3<f32>;
	var gt: vec3<f32>;
	var lt: vec3<f32>;
	var o1: vec3<f32>;
	var o2: vec3<f32>;
	var v0: vec3<f32>;
	var v1: vec3<f32>;
	var v2: vec3<f32>;
	var v3: vec3<f32>;
	var x0: vec3<f32>;
	var x1: vec3<f32>;
	var x2: vec3<f32>;
	var x3: vec3<f32>;
	
	uvw = M * x;
	i0 = floor(uvw);
	f0 = uvw - i0;
	gt_ = step(f0.xyx, f0.yzz);
	lt_ = 1.0 - gt_;
	gt = vec3<f32>(lt_.z, gt_.xy);
	lt = vec3<f32>(lt_.xy, gt_.z);
	o1 = min( gt, lt );
	o2 = max( gt, lt );
	i1 = i0 + o1;
	i2 = i0 + o2;
	i3 = i0 + vec3<f32>(1.0,1.0,1.0);
	v0 = Mi * i0;
	v1 = Mi * i1;
	v2 = Mi * i2;
	v3 = Mi * i3;
	x0 = x - v0;
	x1 = x - v1;
	x2 = x - v2;
	x3 = x - v3;
		
	var hash: vec4<f32>;
	var theta: vec4<f32>;
	var sz: vec4<f32>;
	var psi: vec4<f32>;
	var St: vec4<f32>;
	var Ct: vec4<f32>;
	var sz_: vec4<f32>;

	hash = permute289v4f( permute289v4f( permute289v4f( 
		vec4<f32>(i0.z, i1.z, i2.z, i3.z ))
		+ vec4<f32>(i0.y, i1.y, i2.y, i3.y ))
		+ vec4<f32>(i0.x, i1.x, i2.x, i3.x ));
	theta = hash * 3.883222077;
	sz = hash * -0.006920415 + 0.996539792;
	psi = hash * 0.108705628;
	Ct = cos(theta);
	St = sin(theta);
	sz_ = sqrt( 1.0 - sz*sz );

	var gx: vec4<f32>;
	var gy: vec4<f32>;
	var gz: vec4<f32>;
	var px: vec4<f32>;
	var py: vec4<f32>;
	var pz: vec4<f32>;
	var Sp: vec4<f32>;
	var Cp: vec4<f32>;
	var Ctp: vec4<f32>;
	var qx: vec4<f32>;
	var qy: vec4<f32>;
	var qz: vec4<f32>;
	var Sa: vec4<f32>;
	var Ca: vec4<f32>;

	if(alpha != 0.0)
	{
		px = Ct * sz_;
		py = St * sz_;
		pz = sz;
		Sp = sin(psi);
		Cp = cos(psi);
		Ctp = St*Sp - Ct*Cp;
		qx = mix( Ctp*St, Sp, sz);
		qy = mix(-Ctp*Ct, Cp, sz);
		qz = -(py*Cp + px*Sp);
		Sa = vec4<f32>(sin(alpha));
		Ca = vec4<f32>(cos(alpha));
		gx = Ca*px + Sa*qx;
		gy = Ca*py + Sa*qy;
		gz = Ca*pz + Sa*qz;
	}
	else
	{
		gx = Ct * sz_;
		gy = St * sz_;
		gz = sz;  
	}
	
	var g0: vec3<f32>;
	var g1: vec3<f32>;
	var g2: vec3<f32>;
	var g3: vec3<f32>;
	var w: vec4<f32>;
	var w2: vec4<f32>;
	var w3: vec4<f32>;
	var gdotx: vec4<f32>;
	var n: f32;
	
	g0 = vec3<f32>(gx.x, gy.x, gz.x);
	g1 = vec3<f32>(gx.y, gy.y, gz.y);
	g2 = vec3<f32>(gx.z, gy.z, gz.z);
	g3 = vec3<f32>(gx.w, gy.w, gz.w);
	w = 0.5 - vec4<f32>(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3));
	w = max(w, vec4<f32>(0.0, 0.0, 0.0, 0.0));
	w2 = w * w;
	w3 = w2 * w;
	gdotx = vec4<f32>(dot(g0,x0), dot(g1,x1), dot(g2,x2), dot(g3,x3));
	n = 39.5 * dot(w3, gdotx);

	var dw: vec4<f32> = -6.0 * w2 * gdotx;
	var dn0: vec3<f32> = w3.x * g0 + dw.x * x0;
	var dn1: vec3<f32> = w3.y * g1 + dw.y * x1;
	var dn2: vec3<f32> = w3.z * g2 + dw.z * x2;
	var dn3: vec3<f32> = w3.w * g3 + dw.w * x3;
	var g: vec3<f32> = 39.5 * (dn0 + dn1 + dn2 + dn3);
	
	return g;
}
`, [permute289v4f])



const slope = wgslFn(`
fn slope(delta: f32, dim: vec3<f32>, pos: vec3<f32>, time: f32) -> vec3<f32> {
  var delta_dim = dim * delta;
  var pos_sub = vec4(pos - delta_dim, time);
  var pos_add = vec4(pos + delta_dim, time);

  var n1 = vec3(
  noise_simplex_vec4f(pos_sub),
  noise_simplex_vec4f(pos_sub + 17),
  noise_simplex_vec4f(pos_sub - 42),
  );
  
  var n2 = vec3(
  noise_simplex_vec4f(pos_add),
  noise_simplex_vec4f(pos_add + 17),
  noise_simplex_vec4f(pos_add - 42),
  );

  return n1 - n2;
}
`, [noise_simplex_vec4f]);

const octaves = wgslFn(`
fn octaves(pos: vec3<f32>, time: f32) -> vec3<f32>{
  return srdnoise3(pos, time) + srdnoise3(pos / 2, time / 2) + srdnoise3(pos / 4, time / 4);
}
`, [srdnoise3])


const level = wgslFn(`
fn level(posa: vec3<f32>, elscale: f32, time: f32, speed: f32, force: vec3<f32>) -> vec3<f32> {

var pos = posa;

var delta = 0.0001;
var dx = octaves(pos, time);
var dy = octaves(pos + 17, time);
var dz = octaves(pos - 42, time);


var curl = vec3(
  (dy.z - dz.y) / (2 * delta), 
  (dy.x - dz.z) / (2 * delta), 
  (dy.y - dz.x) / (2 * delta)
);

    
return force +  (normalize(curl) * (speed / elscale));
}
`, [octaves])


export const curl = wgslFn(`
fn curl(index: f32, posa: vec3<f32>, elscale: f32, time: f32, speed: f32, force: vec3<f32>, ) -> vec3<f32> {

 var uv = vec2(index + 22, index + 84);
  var dt = dot(uv.xy, vec2(12.9898, 78.233));
  var sn = dt % 3.141592653589793;
  var newspeed = fract(sin(sn) * 43758.5453);

newspeed = (newspeed * 0.05 + 0.95) * speed;

return level(posa, elscale, time, newspeed, force);
}
`, [level])
