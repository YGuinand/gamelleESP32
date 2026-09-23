#include <Arduino.h>
#include <Wire.h>
#include <rgb_lcd.h>

// Configuration des broches
#define PIN_SDA 21
#define PIN_SCL 22

#define PIN_BTN_JAUNE 14
#define PIN_BTN_VERT  12
#define PIN_BTN_BLEU  15

#define PIN_LED_JAUNE 4
#define PIN_LED_VERT  2

#define PIN_POTENTIOMETRE 25

// Instance de l'écran LCD Grove RGB
rgb_lcd lcd;

// Structures pour la gestion des boutons (anti-rebond logiciel)
struct Button {
    uint8_t pin;
    uint8_t id;
    bool lastState;
    unsigned long lastDebounceTime;
};

Button buttons[] = {
    {PIN_BTN_JAUNE, 1, LOW, 0},
    {PIN_BTN_VERT,  2, LOW, 0},
    {PIN_BTN_BLEU,  3, LOW, 0}
};
const uint8_t numButtons = sizeof(buttons) / sizeof(Button);
const unsigned long debounceDelay = 50;

// État actuel du rétroéclairage
uint8_t currentR = 255;
uint8_t currentG = 255;
uint8_t currentB = 255;

// Variables pour le potentiomètre (20Hz max -> intervalle de 50ms)
int lastPotValue = -10; // Initialisé bas pour forcer la première lecture
unsigned long lastPotTime = 0;
const unsigned long potInterval = 50; 

void updateBacklight() {
    if (digitalRead(PIN_BTN_JAUNE) == HIGH) {
        if (currentR != 255 || currentG != 255 || currentB != 0) {
            lcd.setRGB(255, 255, 0);
            currentR = 255; currentG = 255; currentB = 0;
        }
    } 
    else if (digitalRead(PIN_BTN_VERT) == HIGH) {
        if (currentR != 0 || currentG != 255 || currentB != 0) {
            lcd.setRGB(0, 255, 0);
            currentR = 0; currentG = 255; currentB = 0;
        }
    } 
    else if (digitalRead(PIN_BTN_BLEU) == HIGH) {
        if (currentR != 0 || currentG != 0 || currentB != 255) {
            lcd.setRGB(0, 0, 255);
            currentR = 0; currentG = 0; currentB = 255;
        }
    } 
    else {
        if (currentR != 255 || currentG != 255 || currentB != 255) {
            lcd.setRGB(255, 255, 255);
            currentR = 255; currentG = 255; currentB = 255;
        }
    }
}

void setup() {
    Serial.begin(115200);

    Wire.begin(PIN_SDA, PIN_SCL);

    lcd.begin(16, 2);
    lcd.setRGB(255, 255, 255);
    
    lcd.setCursor(0, 0);
    lcd.print("IUT de Cachan");

    pinMode(PIN_BTN_JAUNE, INPUT);
    pinMode(PIN_BTN_VERT, INPUT);
    pinMode(PIN_BTN_BLEU, INPUT);

    pinMode(PIN_LED_JAUNE, OUTPUT);
    pinMode(PIN_LED_VERT, OUTPUT);
    
    digitalWrite(PIN_LED_JAUNE, LOW);
    digitalWrite(PIN_LED_VERT, LOW);

    pinMode(PIN_POTENTIOMETRE, ANALOG);
}

void loop() {
    while (Serial.available() > 0) {
        Serial.read(); 
    }

    // Gestion des boutons avec anti-rebond
    for (uint8_t i = 0; i < numButtons; i++) {
        bool reading = (digitalRead(buttons[i].pin) == HIGH);

        if (reading != buttons[i].lastState && (millis() - buttons[i].lastDebounceTime) > debounceDelay) {
            buttons[i].lastState = reading;
            buttons[i].lastDebounceTime = millis();

            if (reading) {
                Serial.write('D');
                Serial.print(buttons[i].id);
                Serial.write(0x0A);
            } else {
                Serial.write('U');
                Serial.print(buttons[i].id);
                Serial.write(0x0A);
            }
        }
    }

    // Lecture du potentiomètre à fréquence maximale de 20 Hz (50 ms)
    if (millis() - lastPotTime >= potInterval) {
        lastPotTime = millis();
        int currentPotValue = analogRead(PIN_POTENTIOMETRE);

        // Envoi uniquement si la variation stricte est supérieure à +/- 1
        if (abs(currentPotValue - lastPotValue) > 1) {
            lastPotValue = currentPotValue;
            Serial.print("PA");
            Serial.print(currentPotValue);
            Serial.write(0x0A);
        }
    }

    digitalWrite(PIN_LED_JAUNE, digitalRead(PIN_BTN_JAUNE));
    digitalWrite(PIN_LED_VERT, digitalRead(PIN_BTN_VERT));

    updateBacklight();
}
