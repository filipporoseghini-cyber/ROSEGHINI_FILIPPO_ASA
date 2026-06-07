import { DjsConnect, DjsClientSocket } from "@unitn-asa/deliveroo-js-sdk";



const socket = DjsConnect(

// "https://deliveroojs.bears.disi.unitn.it", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjVjY2FjMCIsIm5hbWUiOiJmaWxpcHBvX3Jvc2VnaGluaSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzc1MDUyMDE3fQ.Nx_quGFWr45bWa3sLNn_upefVA4ZtzYs0PWjSXAhq2g" );

"http://localhost:8080/", "");



socket.onConnect(() => {

console.log("Connected");

});



//socket.onYou(me => console.log("My name is " + me.name));

let myPosition = null;



socket.onYou((me) => {

const newPosition = me.position ?? (

typeof me.x === "number" && typeof me.y === "number"

? { x: me.x, y: me.y }

: null

);



if (!newPosition) {

console.warn("Position missing in onYou payload", me);

return;

}



const isFullCell = Number.isInteger(newPosition.x) && Number.isInteger(newPosition.y);

if (!isFullCell) {

return;

}



if (!myPosition || newPosition.x !== myPosition.x || newPosition.y !== myPosition.y) {

myPosition = newPosition;

console.log("Moved to " + myPosition.x + " " + myPosition.y);

}

});