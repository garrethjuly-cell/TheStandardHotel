
const rooms = [
  {
    id:"standard", name:"Standard Suite",
    priceSingle:50, priceDouble:60,
    size:"28 m²", bed:"Twin", view:"Garden", accessible:true,
    img:"assets/images/rooms/standard/standard-suite-1.webp",
    gallery:[
      "assets/images/rooms/standard/standard-suite-1.webp",
      "assets/images/rooms/standard/standard-suite-2.jpg",
      "assets/images/rooms/standard/standard-suite-3.jpg",
      "assets/images/rooms/standard/standard-suite-4.jpg",
      "assets/images/rooms/standard/standard-suite-5.jpg"
    ]
  },
  {
    id:"executive", name:"Executive Suite",
    priceSingle:60, priceDouble:70,
    size:"46 m²", bed:"King", view:"City", accessible:true,
    img:"assets/images/rooms/executive/executive-1.jpg",
    gallery:[
      "assets/images/rooms/executive/executive-1.jpg",
      "assets/images/rooms/executive/executive-2.jpg",
      "assets/images/rooms/executive/executive-3.jpg",
      "assets/images/rooms/executive/executive-4.jpg",
      "assets/images/rooms/executive/executive-5.jpg"
    ]
  },
  {
    id:"deluxe", name:"Deluxe Suite",
    price:100,
    size:"38 m²", bed:"King", view:"City", accessible:false,
    img:"assets/images/rooms/deluxe/deluxe-1.jpg",
    gallery:[
      "assets/images/rooms/deluxe/deluxe-1.jpg",
      "assets/images/rooms/deluxe/deluxe-2.jpg",
      "assets/images/rooms/deluxe/deluxe-3.jpg",
      "assets/images/rooms/deluxe/deluxe-4.jpg",
      "assets/images/rooms/deluxe/deluxe-5.jpg"
    ]
  },
  {
    id:"penthouse", name:"Penthouse Suite",
    price:150,
    amenity:"Jacuzzi included",
    size:"112 m²", bed:"King", view:"Panoramic", accessible:false,
    img:"assets/images/rooms/penthouse/penthouse-suite-1.jpg",
    gallery:[
      "assets/images/rooms/penthouse/penthouse-suite-1.jpg",
      "assets/images/rooms/penthouse/penthouse-suite-2.jpg",
      "assets/images/rooms/penthouse/penthouse-suite-3.webp",
      "assets/images/rooms/penthouse/penthouse-suite-4.jpg",
      "assets/images/rooms/penthouse/penthouse-suite-5.webp"
    ]
  }
];
const addOns = [
  {id:"breakfast", name:"Breakfast for two", price:32},
  {id:"transfer", name:"Airport transfer", price:45},
  {id:"spa", name:"Spa credit", price:75},
  {id:"late", name:"Late check-out", price:30},
  {id:"celebration", name:"Celebration setup", price:55}
];

function nights(a,b){
  const x=new Date(a), y=new Date(b);
  const n=Math.ceil((y-x)/86400000);
  return Number.isFinite(n)&&n>0?n:0;
}
function money(n){return "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:0});}
function roomRate(r,guestCount){
  if(r.priceSingle!=null&&r.priceDouble!=null){
    return (Number(guestCount)||2)<=1 ? r.priceSingle : r.priceDouble;
  }
  return r.price;
}
function rateLabel(r){
  if(r.priceSingle!=null&&r.priceDouble!=null) return `${money(r.priceSingle)} single · ${money(r.priceDouble)} double`;
  return "";
}
function getState(){
  try{return JSON.parse(localStorage.getItem("hotelBooking"))||{};}catch{return {}}
}
function saveState(s){localStorage.setItem("hotelBooking",JSON.stringify(s));}

function initAI(){
  const fab=document.querySelector("#aiFab"), panel=document.querySelector("#aiPanel"), close=document.querySelector("#aiClose"), form=document.querySelector("#aiForm"), input=document.querySelector("#aiInput"), messages=document.querySelector("#aiMessages");
  if(!fab||!panel)return;
  const add=(text,who="bot")=>{const d=document.createElement("div");d.className="ai-msg "+who;d.textContent=text;messages.appendChild(d);messages.scrollTop=messages.scrollHeight};
  const reply=(q)=>{const x=q.toLowerCase(); if(x.includes("room")||x.includes("rate")||x.includes("price"))return "You can explore our rooms and rates on Rooms & Booking. For a live quote or availability confirmation, message the hotel on WhatsApp."; if(x.includes("location")||x.includes("where")||x.includes("address"))return "The Standard Hotel is in Bulawayo, Zimbabwe. Use the About & Contact page for directions, or contact our team on WhatsApp."; if(x.includes("check-in")||x.includes("check in"))return "Check-in details can be confirmed directly with the hotel. I can connect you to WhatsApp for the latest arrival information."; if(x.includes("whatsapp")||x.includes("book")||x.includes("contact"))return "Absolutely. Tap WhatsApp below to start a direct enquiry with The Standard Hotel."; return "I can help with rooms, rates, check-in, location and contacting the hotel. For anything specific, please use WhatsApp and our team can assist."};
  fab.addEventListener("click",()=>{const open=panel.hasAttribute("hidden"); if(open){panel.removeAttribute("hidden");fab.setAttribute("aria-expanded","true");input?.focus()}else{panel.setAttribute("hidden","");fab.setAttribute("aria-expanded","false")}});
  close?.addEventListener("click",()=>{panel.setAttribute("hidden","");fab.setAttribute("aria-expanded","false")});
  form?.addEventListener("submit",e=>{e.preventDefault();const q=input.value.trim();if(!q)return;add(q,"user");input.value="";setTimeout(()=>add(reply(q)),180)});
  document.querySelectorAll("[data-ai]").forEach(b=>b.addEventListener("click",()=>{const q=b.dataset.ai;const text=q==="rooms"?"What rooms and rates do you have?":q==="location"?"Where are you located?":q==="checkin"?"What are your check-in details?":"I want to contact the hotel on WhatsApp.";add(text,"user");setTimeout(()=>add(reply(text)),180)}));
}

function initNav(){
  const btn=document.querySelector(".menu-btn"), nav=document.querySelector(".mobile-nav");
  if(btn&&nav) btn.addEventListener("click",()=>nav.classList.toggle("open"));
}

function initBookingBar(){
  const form=document.querySelector("#quickBooking");
  if(!form)return;
  const checkin=form.querySelector("[name=checkin]"), checkout=form.querySelector("[name=checkout]"), guests=form.querySelector("[name=guests]");
  const today=new Date().toISOString().slice(0,10);
  checkin.min=today; checkout.min=today;
  checkin.addEventListener("change",()=>{checkout.min=checkin.value; if(checkout.value<=checkin.value) checkout.value=""});
  form.addEventListener("submit",e=>{
    e.preventDefault();
    if(nights(checkin.value,checkout.value)<1){alert("Please select valid check-in and check-out dates.");return}
    saveState({checkin:checkin.value,checkout:checkout.value,guests:Number(guests.value),roomId:null,addons:{}});
    location.href="rooms.html#availability";
  });
}

function initCarousels(root){
  root.querySelectorAll(".carousel").forEach(carousel=>{
    if(carousel.dataset.carouselReady==="true") return;
    carousel.dataset.carouselReady="true";
    const track=carousel.querySelector(".carousel-track");
    const slides=carousel.querySelectorAll(".carousel-track img");
    const dots=carousel.querySelectorAll(".carousel-dots .dot");
    const count=carousel.querySelector(".carousel-count");
    if(!track||slides.length<2)return;
    let i=0;
    const go=n=>{
      i=(n+slides.length)%slides.length;
      track.style.transform=`translateX(-${i*100}%)`;
      dots.forEach((d,di)=>d.classList.toggle("active",di===i));
      if(count) count.textContent=`${i+1} / ${slides.length}`;
    };
    carousel.querySelector(".carousel-btn.prev")?.addEventListener("click",e=>{e.stopPropagation();go(i-1)});
    carousel.querySelector(".carousel-btn.next")?.addEventListener("click",e=>{e.stopPropagation();go(i+1)});
    dots.forEach((d,di)=>d.addEventListener("click",e=>{e.stopPropagation();go(di)}));
    let startX=null;
    carousel.addEventListener("touchstart",e=>{startX=e.touches[0].clientX},{passive:true});
    carousel.addEventListener("touchend",e=>{
      if(startX==null)return;
      const dx=e.changedTouches[0].clientX-startX;
      if(Math.abs(dx)>40) go(dx<0?i+1:i-1);
      startX=null;
    },{passive:true});
  });
}

function initRooms(){
  const root=document.querySelector("#roomResults"), summary=document.querySelector("#summary");
  if(!root||!summary)return;
  const checkin=document.querySelector("#checkin"), checkout=document.querySelector("#checkout"), guests=document.querySelector("#guests");
  const s=getState();
  checkin.value=s.checkin||"";
  checkout.value=s.checkout||"";
  guests.value=s.guests||2;
  const today=new Date().toISOString().slice(0,10);
  checkin.min=today; checkout.min=today;
  const filters={view:"all",bed:"all",accessible:false};

  function render(){
    let list=rooms.filter(r=>
      (filters.view==="all"||r.view.toLowerCase()===filters.view) &&
      (filters.bed==="all"||r.bed.toLowerCase()===filters.bed) &&
      (!filters.accessible||r.accessible)
    );
    root.innerHTML=list.map(r=>{
      const rate=roomRate(r,guests.value);
      const label=rateLabel(r);
      const multi=r.gallery.length>1;
      return `
      <article class="result-card fade visible">
        <div class="photo carousel">
          <div class="carousel-track">${r.gallery.map(src=>`<img src="${src}" alt="${r.name} at The Standard Hotel" loading="lazy">`).join("")}</div>
          ${multi?`<button type="button" class="carousel-btn prev" aria-label="Previous photo of ${r.name}">‹</button><button type="button" class="carousel-btn next" aria-label="Next photo of ${r.name}">›</button><div class="carousel-dots">${r.gallery.map((g,di)=>`<button type="button" class="dot${di===0?" active":""}" aria-label="Photo ${di+1} of ${r.name}"></button>`).join("")}</div><div class="carousel-count">1 / ${r.gallery.length}</div>`:""}
        </div>
        <div class="details">
          <div class="tag">Available for selected dates</div>
          <h3>${r.name}</h3>
          <div class="card-meta"><span>${r.size}</span><span>${r.bed} bed</span><span>${r.view} view</span></div>
          <p class="muted">Linen bedding, marble bathroom, complimentary Wi‑Fi and evening turndown.</p>
          ${r.amenity?`<div class="rate-note">✦ ${r.amenity}</div>`:""}
          ${label?`<div class="rate-note">${label}</div>`:""}
          <div class="price"><div><small>From</small><br><strong>${money(rate)}</strong> / night</div><button class="btn btn-gold select-room" data-room="${r.id}">Select Room</button></div>
          <div class="addons">
            ${addOns.map(a=>`<label class="addon"><span><input type="checkbox" data-addon="${a.id}"> ${a.name}</span><strong>${money(a.price)}</strong></label>`).join("")}
          </div>
        </div>
      </article>`;
    }).join("");
    document.querySelectorAll(".select-room").forEach(b=>b.addEventListener("click",()=>{
      saveState({...getState(),roomId:b.dataset.room});
      updateSummary();
      summary.scrollIntoView({behavior:"smooth",block:"nearest"});
    }));
    document.querySelectorAll("[data-addon]").forEach(c=>c.addEventListener("change",updateSummary));
    initCarousels(root);
    updateSummary();
  }
  window.addEventListener('hotelRatesUpdated', render);
  function updateSummary(){
    const state=getState(), room=rooms.find(r=>r.id===state.roomId);
    const n=nights(checkin.value,checkout.value);
    let subtotal=room?roomRate(room,guests.value)*n:0, extras=0;
    document.querySelectorAll("[data-addon]:checked").forEach(c=>{
      const a=addOns.find(x=>x.id===c.dataset.addon); extras+=a.price;
    });
    const tax=(subtotal+extras)*.12, total=subtotal+extras+tax;
    summary.innerHTML=`
      <h3>Your stay</h3>
      <div class="summary-row"><span>Dates</span><span>${checkin.value&&checkout.value?`${checkin.value} → ${checkout.value}`:"Select dates"}</span></div>
      <div class="summary-row"><span>Guests</span><span>${guests.value||2}</span></div>
      <div class="summary-row"><span>Room</span><span>${room?room.name:"Not selected"}</span></div>
      <div class="summary-row"><span>Room rate</span><span>${money(subtotal)}</span></div>
      <div class="summary-row"><span>Add-ons</span><span>${money(extras)}</span></div>
      <div class="summary-row"><span>Taxes & fees</span><span>${money(tax)}</span></div>
      <div class="summary-total"><span>Total</span><span>${money(total)}</span></div>
      <div class="promo"><input id="promo" placeholder="Promo code"><button id="applyPromo">Apply</button></div>
      <button class="btn btn-gold" style="width:100%;margin-top:12px" id="reserve">Continue to Secure Payment</button>
      <p style="font-size:.7rem;color:#aaa;margin:12px 0 0">Free cancellation up to 48 hours before arrival. Secure checkout.</p>`;
    document.querySelector("#reserve").addEventListener("click", async ()=>{
      if(!room||n<1){alert("Select valid check-in and check-out dates and a room first.");return}
      const selectedAddons=[...document.querySelectorAll("[data-addon]:checked")].map(c=>c.dataset.addon);
      saveState({...getState(),checkin:checkin.value,checkout:checkout.value,guests:Number(guests.value),roomId:room.id,addons:selectedAddons});
      const reserveButton=document.querySelector("#reserve");
      reserveButton.disabled=true;
      reserveButton.textContent="Connecting to secure checkout…";
      try{
        const response=await fetch("/api/paynow/initiate",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            checkin:checkin.value,
            checkout:checkout.value,
            guests:Number(guests.value)||2,
            roomId:room.id,
            addons:selectedAddons
          })
        });
        const result=await response.json();
        if(!response.ok||!result.success||!result.redirectUrl){
          throw new Error(result.error||"Unable to start Paynow checkout.");
        }
        window.location.assign(result.redirectUrl);
      }catch(error){
        alert(error.message||"Could not connect to Paynow. Please try again.");
        reserveButton.disabled=false;
        reserveButton.textContent="Continue to Secure Payment";
      }
    });
    document.querySelector("#applyPromo").addEventListener("click",()=>{
      const code=document.querySelector("#promo").value.trim().toUpperCase();
      if(code==="WELCOME10") alert("Promo applied: 10% direct-booking discount (demo).");
      else alert("Promo code not recognized.");
    });
  }
  [checkin,checkout].forEach(el=>el.addEventListener("change",()=>{saveState({...getState(),checkin:checkin.value,checkout:checkout.value,guests:Number(guests.value)});updateSummary()}));
  guests.addEventListener("change",()=>{saveState({...getState(),checkin:checkin.value,checkout:checkout.value,guests:Number(guests.value)});render()});
  document.querySelectorAll(".filter").forEach(b=>b.addEventListener("click",()=>{
    document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    const key=b.dataset.filter, val=b.dataset.value;
    if(key==="accessible")filters.accessible=!filters.accessible;
    else filters[key]=val;
    render();
  }));
  render();
}

function initCookie(){
  const c=document.querySelector("#cookie");
  if(!c)return;
  if(localStorage.getItem("hotelCookieOK")) c.remove();
  else c.querySelector("button").addEventListener("click",()=>{localStorage.setItem("hotelCookieOK","1");c.remove()});
}
function initFade(){
  const els=document.querySelectorAll(".fade");
  const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add("visible")}),{threshold:.12});
  els.forEach(e=>io.observe(e));
}
document.addEventListener("DOMContentLoaded",()=>{document.documentElement.style.overflowX="hidden";initNav();initBookingBar();initRooms();initCarousels(document);initCookie();initFade();initAI()});
