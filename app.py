import streamlit as st
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

# 🎨 Ρύθμιση της σελίδας του Streamlit
st.set_page_config(page_title="Routiq AI Scheduler", page_icon="🚀", layout="centered")

st.title("🚀 Routiq AI - Έξυπνο Πλάνο Μαθημάτων")
st.subheader("Βελτιστοποίηση Διαδρομής & Χρονικών Παραθύρων")
st.write("Ο αλγόριθμος υπολογίζει την ιδανική σειρά των μαθητών για να γλιτώσεις χρόνο και βενζίνη!")

def create_data_model():
    data = {}
    # Διάρκεια μαθήματος: Depot(0), S001(60), S002(45), S003(90), S004(60)
    data['service_time'] = [0, 60, 45, 90, 60] 
    
    # Χρονικά παράθυρα (σε λεπτά από την έναρξη της ημέρας)
    data['time_windows'] = [
        (0, 1440),  # Καθηγητής (Όλη μέρα)
        (300, 780), # Student S001 (05:00 - 13:00)
        (420, 720), # Student S002 (07:00 - 12:00)
        (540, 840), # Student S003 (09:00 - 14:00)
        (360, 780)  # Student S004 (06:00 - 13:00)
    ]
    
    # Χρόνοι οδήγησης μεταξύ των σημείων
    data['distance_matrix'] = [
        [0, 18, 22, 34, 45],
        [18, 0, 17, 32, 50],
        [22, 17, 0, 39, 56],
        [34, 32, 39, 0, 24],
        [45, 50, 56, 24, 0]
    ]
    data['depot'] = 0
    return data

def display_streamlit_solution(manager, routing, solution):
    """Εμφανίζει τα αποτελέσματα με όμορφο τρόπο στο Streamlit UI."""
    st.success(f"🎯 Βρέθηκε η βέλτιστη λύση! Συνολικός χρόνος (Οδήγηση + Αναμονή): **{solution.ObjectiveValue()} λεπτά**")
    
    index = routing.Start(0)
    time_dimension = routing.GetDimensionOrDie('Time')
    
    # Δημιουργία μιας ωραίας λίστας (Timeline) στην οθόνη
    st.info("📅 **Πλάνο Δρομολογίου:**")
    
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        time_var = time_dimension.CumulVar(index)
        min_time = solution.Min(time_var)
        
        # Μετατροπή λεπτών σε μορφή Ώρα:Λεπτά (π.χ. 300 -> 05:00)
        hours = min_time // 60
        minutes = min_time % 60
        time_string = f"{hours:02d}:{minutes:02d}"
        
        if node == 0:
            st.markdown(f"🏠 **Αναχώρηση από το Σπίτι** ➔ 🕐 Ώρα: `{time_string}`")
        else:
            st.write(f"📖 **Μαθητής S00{node}** ➔ 🕐 Άφιξη: `{time_string}` (Διάρκεια: {create_data_model()['service_time'][node]} λεπτά)")
            
        index = solution.Value(routing.NextVar(index))

    # Επιστροφή
    time_var = time_dimension.CumulVar(index)
    min_time = solution.Min(time_var)
    time_string = f"{min_time // 60:02d}:{min_time % 60:02d}"
    st.markdown(f"🏠 **Επιστροφή στο Σπίτι** ➔ 🕐 Ώρα: `{time_string}`")

def main():
    data = create_data_model()
    manager = pywrapcp.RoutingIndexManager(len(data['distance_matrix']), 1, data['depot'])
    routing = pywrapcp.RoutingModel(manager)

    def time_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return data['distance_matrix'][from_node][to_node] + data['service_time'][from_node]

    transit_callback_index = routing.RegisterTransitCallback(time_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    time = 'Time'
    routing.AddDimension(transit_callback_index, 1440, 1440, True, time)
    time_dimension = routing.GetDimensionOrDie(time)
    
    for location_idx, time_window in enumerate(data['time_windows']):
        if location_idx != data['depot']:
            index = manager.NodeToIndex(location_idx)
            time_dimension.CumulVar(index).SetRange(time_window[0], time_window[1])

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC)

    # 🎛️ Κουμπί για την εκτέλεση του αλγορίθμου
    if st.button("📊 Υπολογισμός Ιδανικού Προγράμματος", type="primary"):
        solution = routing.SolveWithParameters(search_parameters)
        if solution:
            display_streamlit_solution(manager, routing, solution)
        else:
            st.error("❌ Δεν βρέθηκε εφικτή λύση! Δοκιμάστε να αλλάξετε τα χρονικά παράθυρα.")

if __name__ == '__main__':
    main()
