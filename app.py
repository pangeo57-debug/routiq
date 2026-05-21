import streamlit as st

st.title("🚀 Routiq SaaS - Live!")
st.write("Παναγιώτη, το site σου λειτουργεί ΚΑΝΟΝΙΚΑ στο Cloud!")

test_time = st.slider("Δοκιμή Slider (Λεπτά)", 10, 120, 60)
st.metric("Χρόνος", f"{test_time} λεπτά")
